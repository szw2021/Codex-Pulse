#import "CodexScanner.h"
#import <sqlite3.h>
#include <float.h>

static NSString * _Nullable CPColumnText(sqlite3_stmt *statement, int column);
static NSDate * _Nullable CPParseDate(id value);
static NSString *CPCleanTitle(NSString *title, NSString *fallbackID);
static NSString * _Nullable CPCleanPrompt(id value);
static NSString * _Nullable CPCleanError(NSDictionary *payload);
static NSDictionary *CPStateResult(NSString *state,
                                   NSString *detail,
                                   NSDate *updatedAt,
                                   NSString * _Nullable lastPrompt);
static NSString * _Nullable CPPromptFromJSONLine(NSData *lineData);
static BOOL CPNeedsAttention(NSDictionary *call, NSString *approvalMode, BOOL hasWorkingChild, NSDate *now);
static NSString *CPAttentionDetail(NSString *toolName);

static NSString * const CPScannerErrorDomain = @"dev.local.codex-pulse.scanner";

@interface CodexScanner ()
@property(nonatomic, strong) NSURL *codexHome;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *stateCache;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *promptCache;
@end

@implementation CodexScanner

- (instancetype)initWithCodexHome:(NSURL *)codexHome {
    self = [super init];
    if (self) {
        _codexHome = codexHome.standardizedURL;
        _stateCache = [NSMutableDictionary dictionary];
        _promptCache = [NSMutableDictionary dictionary];
    }
    return self;
}

- (NSArray<NSDictionary *> *)scanSessionsWithError:(NSError **)error {
    NSURL *databaseURL = [self.codexHome URLByAppendingPathComponent:@"state_5.sqlite"];
    NSURL *sessionsRoot = [self.codexHome URLByAppendingPathComponent:@"sessions" isDirectory:YES];
    NSDictionary<NSString *, NSDictionary *> *processes = [self activeSessionProcessesAtRoot:sessionsRoot];

    sqlite3 *database = NULL;
    int openResult = sqlite3_open_v2(databaseURL.fileSystemRepresentation,
                                     &database,
                                     SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX,
                                     NULL);
    if (openResult != SQLITE_OK || database == NULL) {
        NSString *message = database ? [NSString stringWithUTF8String:sqlite3_errmsg(database)] : @"unknown error";
        if (database) sqlite3_close(database);
        if (error) {
            *error = [NSError errorWithDomain:CPScannerErrorDomain
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey:
                                                    [NSString stringWithFormat:@"无法打开 Codex 状态数据库：%@", message]}];
        }
        return @[];
    }
    sqlite3_busy_timeout(database, 1000);

    const char *sql =
        "SELECT id, rollout_path, updated_at, source, cwd, "
        "COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(preview, ''), id), "
        "approval_mode, model, "
        "COALESCE(NULLIF(preview, ''), NULLIF(first_user_message, ''), NULLIF(title, ''), id) "
        "FROM threads "
        "WHERE archived = 0 AND source = 'cli' "
        "ORDER BY updated_at DESC LIMIT 100;";

    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        NSString *message = [NSString stringWithUTF8String:sqlite3_errmsg(database)];
        sqlite3_close(database);
        if (error) {
            *error = [NSError errorWithDomain:CPScannerErrorDomain
                                         code:2
                                     userInfo:@{NSLocalizedDescriptionKey:
                                                    [NSString stringWithFormat:@"无法读取 Codex 会话：%@", message]}];
        }
        return @[];
    }

    NSMutableArray<NSDictionary *> *sessions = [NSMutableArray array];
    NSMutableSet<NSString *> *scannedPaths = [NSMutableSet set];
    NSFileManager *fileManager = NSFileManager.defaultManager;

    while (sqlite3_step(statement) == SQLITE_ROW) {
        NSString *sessionID = CPColumnText(statement, 0);
        NSString *rolloutPath = CPColumnText(statement, 1);
        NSString *source = CPColumnText(statement, 3) ?: @"cli";
        NSString *cwd = CPColumnText(statement, 4) ?: @"";
        NSString *title = CPColumnText(statement, 5) ?: sessionID;
        NSString *approvalMode = CPColumnText(statement, 6) ?: @"never";
        NSString *model = CPColumnText(statement, 7);
        NSString *fallbackPrompt = CPColumnText(statement, 8) ?: title;
        if (sessionID.length == 0 || rolloutPath.length == 0) continue;

        rolloutPath = [NSURL fileURLWithPath:rolloutPath].standardizedURL.path;
        if (![fileManager fileExistsAtPath:rolloutPath]) continue;
        [scannedPaths addObject:rolloutPath];

        NSDictionary *processInfo = processes[rolloutPath];
        NSDictionary *attributes = [fileManager attributesOfItemAtPath:rolloutPath error:nil];
        NSDate *modifiedAt = attributes[NSFileModificationDate];
        NSNumber *fileSize = attributes[NSFileSize] ?: @0;
        id processKey = processInfo ?: NSNull.null;
        NSDictionary *cached = self.stateCache[rolloutPath];
        BOOL cacheMatches = cached &&
            [cached[@"fileSize"] isEqual:fileSize] &&
            [cached[@"modifiedAt"] isEqual:modifiedAt ?: NSNull.null] &&
            [cached[@"approvalMode"] isEqualToString:approvalMode] &&
            [cached[@"processInfo"] isEqual:processKey];

        NSDictionary *state = cacheMatches ? cached[@"result"] : nil;
        if (!state) {
            NSData *tail = [self tailDataAtPath:rolloutPath maximumBytes:524288];
            state = tail.length > 0
                ? [CodexScanner detectStateInData:tail
                                     approvalMode:approvalMode
                                       processInfo:processInfo
                                    fileModifiedAt:modifiedAt
                                               now:NSDate.date]
                : @{ @"state": processInfo ? @"active" : @"failed",
                     @"detail": processInfo ? @"Codex 正在运行" : @"会话记录不可读",
                     @"updatedAt": modifiedAt ?: NSDate.date };

            NSString *detectedState = state[@"state"];
            if ([detectedState isEqualToString:@"completed"] ||
                [detectedState isEqualToString:@"failed"]) {
                self.stateCache[rolloutPath] = @{
                    @"fileSize": fileSize,
                    @"modifiedAt": modifiedAt ?: NSNull.null,
                    @"approvalMode": approvalMode,
                    @"processInfo": processKey,
                    @"result": state
                };
            } else {
                [self.stateCache removeObjectForKey:rolloutPath];
            }
        }

        NSString *lastPrompt = CPCleanPrompt(state[@"lastPrompt"]);
        NSDictionary *promptCache = self.promptCache[rolloutPath];
        unsigned long long currentSize = fileSize.unsignedLongLongValue;
        unsigned long long cachedSize = [promptCache[@"fileSize"] unsignedLongLongValue];
        NSString *cachedPrompt = CPCleanPrompt(promptCache[@"prompt"]);
        if (!lastPrompt) {
            unsigned long long lowerBound = promptCache && currentSize >= cachedSize ? cachedSize : 0;
            if (currentSize > lowerBound || !cachedPrompt) {
                lastPrompt = [self latestUserPromptAtPath:rolloutPath afterOffset:lowerBound];
            }
            if (!lastPrompt) lastPrompt = cachedPrompt;
        }
        if (!lastPrompt) lastPrompt = CPCleanPrompt(fallbackPrompt);
        if (lastPrompt) {
            self.promptCache[rolloutPath] = @{ @"fileSize": fileSize, @"prompt": lastPrompt };
        }

        NSDate *updatedAt = state[@"updatedAt"];
        if (![updatedAt isKindOfClass:NSDate.class]) {
            updatedAt = [NSDate dateWithTimeIntervalSince1970:sqlite3_column_double(statement, 2)];
        }

        NSString *cleanTitle = CPCleanTitle(title, sessionID);
        NSString *projectName = [NSURL fileURLWithPath:cwd].lastPathComponent;
        if (projectName.length == 0) projectName = cwd;

        NSMutableDictionary *session = [@{
            @"id": sessionID,
            @"shortId": [sessionID substringToIndex:MIN((NSUInteger)8, sessionID.length)],
            @"title": cleanTitle,
            @"lastPrompt": lastPrompt ?: cleanTitle,
            @"cwd": cwd,
            @"projectName": projectName ?: @"",
            @"source": source,
            @"rolloutPath": rolloutPath,
            @"state": state[@"state"] ?: @"completed",
            @"detail": state[@"detail"] ?: @"",
            @"updatedAt": @([updatedAt timeIntervalSince1970] * 1000.0)
        } mutableCopy];
        NSString *completionToken = state[@"completionToken"];
        if ([completionToken isKindOfClass:NSString.class] && completionToken.length > 0) {
            session[@"completionKey"] = [NSString stringWithFormat:@"%@:%@", sessionID, completionToken];
        }
        if (model.length > 0) session[@"model"] = model;
        if (processInfo[@"pid"]) session[@"pid"] = processInfo[@"pid"];
        [sessions addObject:session];
    }

    sqlite3_finalize(statement);
    sqlite3_close(database);
    for (NSString *path in self.stateCache.allKeys.copy) {
        if (![scannedPaths containsObject:path]) [self.stateCache removeObjectForKey:path];
    }
    for (NSString *path in self.promptCache.allKeys.copy) {
        if (![scannedPaths containsObject:path]) [self.promptCache removeObjectForKey:path];
    }

    NSDictionary<NSString *, NSNumber *> *priority = @{
        @"active": @0,
        @"completed": @1,
        @"attention": @2,
        @"failed": @3
    };
    [sessions sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
        NSInteger leftPriority = [priority[left[@"state"]] integerValue];
        NSInteger rightPriority = [priority[right[@"state"]] integerValue];
        if (leftPriority != rightPriority) {
            return leftPriority < rightPriority ? NSOrderedAscending : NSOrderedDescending;
        }
        return [right[@"updatedAt"] compare:left[@"updatedAt"]];
    }];
    return sessions;
}

+ (NSDictionary *)detectStateInData:(NSData *)data
                       approvalMode:(NSString *)approvalMode
                         processInfo:(NSDictionary *)processInfo
                      fileModifiedAt:(NSDate *)fileModifiedAt
                                 now:(NSDate *)now {
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (text.length == 0) {
        return CPStateResult(processInfo ? @"active" : @"failed",
                             processInfo ? @"Codex 正在运行" : @"会话记录不可读",
                             fileModifiedAt ?: now,
                             nil);
    }

    NSArray<NSString *> *lines = [text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
    BOOL unfinished = NO;
    BOOL foundBoundary = NO;
    NSString *terminalState = nil;
    NSString *terminalDetail = nil;
    NSString *completionToken = nil;
    NSDate *lastEventAt = nil;
    NSMutableSet<NSString *> *resolvedCalls = [NSMutableSet set];
    NSDictionary *latestCall = nil;
    NSString *lastPrompt = nil;

    for (NSInteger index = (NSInteger)lines.count - 1; index >= 0; index--) {
        NSData *lineData = [lines[index] dataUsingEncoding:NSUTF8StringEncoding];
        if (lineData.length == 0) continue;
        NSDictionary *root = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil];
        if (![root isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *payload = root[@"payload"];
        if (![payload isKindOfClass:NSDictionary.class]) continue;

        NSDate *timestamp = CPParseDate(root[@"timestamp"]);
        if (timestamp && !lastEventAt) lastEventAt = timestamp;
        NSString *outerType = root[@"type"];
        NSString *payloadType = payload[@"type"];

        if ([outerType isEqualToString:@"event_msg"]) {
            if (!lastPrompt && [payloadType isEqualToString:@"user_message"]) {
                lastPrompt = CPCleanPrompt(payload[@"message"]);
            }
            if (!foundBoundary && [payloadType isEqualToString:@"task_started"]) {
                unfinished = YES;
                foundBoundary = YES;
            } else if (!foundBoundary && [payloadType isEqualToString:@"task_complete"]) {
                terminalState = @"completed";
                terminalDetail = @"本轮任务已完成";
                id turnID = payload[@"turn_id"];
                if ([turnID isKindOfClass:NSString.class] && [turnID length] > 0) {
                    completionToken = turnID;
                } else if ([root[@"timestamp"] isKindOfClass:NSString.class]) {
                    completionToken = root[@"timestamp"];
                } else if ([payload[@"completed_at"] respondsToSelector:@selector(stringValue)]) {
                    completionToken = [payload[@"completed_at"] stringValue];
                }
                foundBoundary = YES;
            } else if (!foundBoundary && [payloadType isEqualToString:@"turn_aborted"]) {
                terminalState = @"failed";
                terminalDetail = @"任务已中止";
                foundBoundary = YES;
            } else if (!foundBoundary && [payloadType isEqualToString:@"error"]) {
                terminalState = @"failed";
                terminalDetail = CPCleanError(payload) ?: @"Codex 执行出错";
                foundBoundary = YES;
            }
        }

        if (foundBoundary && lastPrompt) break;
        if (foundBoundary) continue;

        if (![outerType isEqualToString:@"response_item"]) continue;
        if ([payloadType isEqualToString:@"function_call_output"] ||
            [payloadType isEqualToString:@"custom_tool_call_output"]) {
            NSString *callID = payload[@"call_id"];
            if ([callID isKindOfClass:NSString.class]) [resolvedCalls addObject:callID];
        } else if ([payloadType isEqualToString:@"function_call"] ||
                   [payloadType isEqualToString:@"custom_tool_call"]) {
            NSString *callID = payload[@"call_id"] ?: payload[@"id"];
            NSString *name = payload[@"name"] ?: @"tool";
            if (!latestCall &&
                [callID isKindOfClass:NSString.class] &&
                ![resolvedCalls containsObject:callID]) {
                latestCall = @{
                    @"name": [name isKindOfClass:NSString.class] ? name : @"tool",
                    @"startedAt": timestamp ?: NSNull.null
                };
            }
        }
    }

    NSDate *bestUpdatedAt = lastEventAt ?: fileModifiedAt ?: now;
    if (!foundBoundary && processInfo && latestCall) unfinished = YES;

    if (unfinished) {
        BOOL hasWorkingChild = [processInfo[@"hasWorkingChild"] boolValue];
        if (latestCall && CPNeedsAttention(latestCall, approvalMode, hasWorkingChild, now)) {
            id startedAt = latestCall[@"startedAt"];
            return CPStateResult(@"attention",
                                 CPAttentionDetail(latestCall[@"name"]),
                                 [startedAt isKindOfClass:NSDate.class] ? startedAt : bestUpdatedAt,
                                 lastPrompt);
        }

        NSTimeInterval modifiedAgo = fileModifiedAt ? [now timeIntervalSinceDate:fileModifiedAt] : DBL_MAX;
        if (processInfo || modifiedAgo < 12.0) {
            return CPStateResult(@"active",
                                 hasWorkingChild ? @"正在执行命令" : @"Codex 正在思考与执行",
                                 bestUpdatedAt,
                                 lastPrompt);
        }
        return CPStateResult(@"failed", @"会话意外停止，没有完成事件", bestUpdatedAt, lastPrompt);
    }

    if (terminalState) {
        NSMutableDictionary *result = [CPStateResult(terminalState,
                                                     terminalDetail ?: @"",
                                                     bestUpdatedAt,
                                                     lastPrompt) mutableCopy];
        if (completionToken.length > 0) result[@"completionToken"] = completionToken;
        return result;
    }
    if (processInfo) {
        return CPStateResult(@"active", @"Codex 会话已启动", bestUpdatedAt, lastPrompt);
    }
    return CPStateResult(@"completed", @"会话当前空闲", bestUpdatedAt, lastPrompt);
}

- (NSString *)latestUserPromptAtPath:(NSString *)path afterOffset:(unsigned long long)lowerBound {
    NSFileHandle *handle = [NSFileHandle fileHandleForReadingAtPath:path];
    if (!handle) return nil;

    @try {
        unsigned long long end = [handle seekToEndOfFile];
        if (lowerBound > end) lowerBound = 0;
        unsigned long long position = end;
        NSData *carry = NSData.data;
        const unsigned long long chunkSize = 262144;
        const uint8_t newlineByte = '\n';
        NSData *newline = [NSData dataWithBytes:&newlineByte length:1];

        while (position > lowerBound) {
            unsigned long long start = position > chunkSize ? position - chunkSize : 0;
            if (start < lowerBound) start = lowerBound;
            [handle seekToFileOffset:start];
            NSData *chunk = [handle readDataOfLength:(NSUInteger)(position - start)];
            NSMutableData *combined = [chunk mutableCopy];
            if (carry.length > 0) [combined appendData:carry];

            NSUInteger lineEnd = combined.length;
            while (lineEnd > 0) {
                NSRange newlineRange = [combined rangeOfData:newline
                                                      options:NSDataSearchBackwards
                                                        range:NSMakeRange(0, lineEnd)];
                if (newlineRange.location == NSNotFound) break;
                NSUInteger lineStart = NSMaxRange(newlineRange);
                if (lineEnd > lineStart) {
                    NSData *line = [combined subdataWithRange:NSMakeRange(lineStart, lineEnd - lineStart)];
                    NSString *prompt = CPPromptFromJSONLine(line);
                    if (prompt) {
                        [handle closeFile];
                        return prompt;
                    }
                }
                lineEnd = newlineRange.location;
            }

            carry = [combined subdataWithRange:NSMakeRange(0, lineEnd)];
            position = start;
        }

        NSString *prompt = carry.length > 0 ? CPPromptFromJSONLine(carry) : nil;
        [handle closeFile];
        return prompt;
    } @catch (__unused NSException *exception) {
        [handle closeFile];
        return nil;
    }
}

- (NSDictionary<NSString *, NSDictionary *> *)activeSessionProcessesAtRoot:(NSURL *)sessionsRoot {
    NSString *lsof = [self runTool:@"/usr/sbin/lsof" arguments:@[@"-F", @"pn", @"+D", sessionsRoot.path]];
    if (lsof.length == 0) return @{};

    NSMutableDictionary<NSString *, NSNumber *> *pathPIDs = [NSMutableDictionary dictionary];
    NSNumber *currentPID = nil;
    for (NSString *line in [lsof componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
        if ([line hasPrefix:@"p"]) {
            currentPID = @([[line substringFromIndex:1] intValue]);
        } else if ([line hasPrefix:@"n"] && [line hasSuffix:@".jsonl"] && currentPID) {
            NSString *path = [NSURL fileURLWithPath:[line substringFromIndex:1]].standardizedURL.path;
            pathPIDs[path] = currentPID;
        }
    }

    NSDictionary<NSNumber *, NSArray<NSDictionary *> *> *tree = [self processTree];
    NSMutableDictionary<NSString *, NSDictionary *> *result = [NSMutableDictionary dictionary];
    [pathPIDs enumerateKeysAndObjectsUsingBlock:^(NSString *path, NSNumber *pid, BOOL *stop) {
        result[path] = @{
            @"pid": pid,
            @"hasWorkingChild": @([self hasWorkingDescendantOf:pid tree:tree])
        };
    }];
    return result;
}

- (NSDictionary<NSNumber *, NSArray<NSDictionary *> *> *)processTree {
    NSString *output = [self runTool:@"/bin/ps" arguments:@[@"-axo", @"pid=,ppid=,comm="]];
    NSMutableDictionary<NSNumber *, NSMutableArray<NSDictionary *> *> *tree = [NSMutableDictionary dictionary];
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"^\\s*(\\d+)\\s+(\\d+)\\s+(.+)$"
                                                                             options:0 error:nil];
    for (NSString *line in [output componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
        NSTextCheckingResult *match = [regex firstMatchInString:line options:0 range:NSMakeRange(0, line.length)];
        if (!match || match.numberOfRanges != 4) continue;
        NSNumber *pid = @([[line substringWithRange:[match rangeAtIndex:1]] intValue]);
        NSNumber *parent = @([[line substringWithRange:[match rangeAtIndex:2]] intValue]);
        NSString *command = [line substringWithRange:[match rangeAtIndex:3]];
        if (!tree[parent]) tree[parent] = [NSMutableArray array];
        [tree[parent] addObject:@{ @"pid": pid, @"command": command }];
    }
    return tree;
}

- (BOOL)hasWorkingDescendantOf:(NSNumber *)processID
                           tree:(NSDictionary<NSNumber *, NSArray<NSDictionary *> *> *)tree {
    NSMutableArray<NSDictionary *> *queue = [NSMutableArray arrayWithArray:tree[processID] ?: @[]];
    NSMutableSet<NSNumber *> *visited = [NSMutableSet set];
    while (queue.count > 0) {
        NSDictionary *child = queue.lastObject;
        [queue removeLastObject];
        NSNumber *pid = child[@"pid"];
        if ([visited containsObject:pid]) continue;
        [visited addObject:pid];

        NSString *command = [child[@"command"] lowercaseString];
        NSString *lastComponent = command.lastPathComponent;
        BOOL helper = [command containsString:@"codex-code-mode-host"] ||
                      [lastComponent isEqualToString:@"codex"] ||
                      [lastComponent isEqualToString:@"node"];
        if (!helper) return YES;
        [queue addObjectsFromArray:tree[pid] ?: @[]];
    }
    return NO;
}

- (NSString *)runTool:(NSString *)path arguments:(NSArray<NSString *> *)arguments {
    NSTask *task = [[NSTask alloc] init];
    NSPipe *pipe = [NSPipe pipe];
    task.executableURL = [NSURL fileURLWithPath:path];
    task.arguments = arguments;
    task.standardOutput = pipe;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    @try {
        [task launchAndReturnError:nil];
        NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
        [task waitUntilExit];
        return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
    } @catch (__unused NSException *exception) {
        return @"";
    }
}

- (NSData *)tailDataAtPath:(NSString *)path maximumBytes:(unsigned long long)maximumBytes {
    NSFileHandle *handle = [NSFileHandle fileHandleForReadingAtPath:path];
    if (!handle) return nil;
    @try {
        unsigned long long end = [handle seekToEndOfFile];
        unsigned long long start = end > maximumBytes ? end - maximumBytes : 0;
        [handle seekToFileOffset:start];
        NSMutableData *data = [[handle readDataToEndOfFile] mutableCopy];
        [handle closeFile];
        if (start > 0) {
            const uint8_t newline = '\n';
            NSRange firstLine = [data rangeOfData:[NSData dataWithBytes:&newline length:1]
                                           options:0
                                             range:NSMakeRange(0, data.length)];
            if (firstLine.location != NSNotFound) {
                [data replaceBytesInRange:NSMakeRange(0, NSMaxRange(firstLine)) withBytes:NULL length:0];
            }
        }
        return data;
    } @catch (__unused NSException *exception) {
        [handle closeFile];
        return nil;
    }
}

static NSString *CPColumnText(sqlite3_stmt *statement, int column) {
    const unsigned char *value = sqlite3_column_text(statement, column);
    return value ? [NSString stringWithUTF8String:(const char *)value] : nil;
}

static NSDate *CPParseDate(id value) {
    if (![value isKindOfClass:NSString.class]) return nil;
    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    NSDate *date = [formatter dateFromString:value];
    if (date) return date;
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    return [formatter dateFromString:value];
}

static NSString *CPCleanTitle(NSString *title, NSString *fallbackID) {
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"\\s+" options:0 error:nil];
    NSString *clean = [regex stringByReplacingMatchesInString:title
                                                      options:0
                                                        range:NSMakeRange(0, title.length)
                                                 withTemplate:@" "];
    clean = [clean stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (clean.length == 0 || [clean isEqualToString:fallbackID]) {
        NSUInteger length = MIN((NSUInteger)8, fallbackID.length);
        return [NSString stringWithFormat:@"Codex 会话 %@", [fallbackID substringToIndex:length]];
    }
    return clean.length > 100 ? [[clean substringToIndex:100] stringByAppendingString:@"…"] : clean;
}

static NSString *CPCleanPrompt(id value) {
    if (![value isKindOfClass:NSString.class]) return nil;
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"\\s+" options:0 error:nil];
    NSString *clean = [regex stringByReplacingMatchesInString:value
                                                      options:0
                                                        range:NSMakeRange(0, [value length])
                                                 withTemplate:@" "];
    clean = [clean stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (clean.length == 0) return nil;
    return clean.length > 500 ? [[clean substringToIndex:500] stringByAppendingString:@"…"] : clean;
}

static NSDictionary *CPStateResult(NSString *state,
                                   NSString *detail,
                                   NSDate *updatedAt,
                                   NSString *lastPrompt) {
    NSMutableDictionary *result = [@{
        @"state": state,
        @"detail": detail,
        @"updatedAt": updatedAt
    } mutableCopy];
    if (lastPrompt.length > 0) result[@"lastPrompt"] = lastPrompt;
    return result;
}

static NSString *CPPromptFromJSONLine(NSData *lineData) {
    NSDictionary *root = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil];
    if (![root isKindOfClass:NSDictionary.class] || ![root[@"type"] isEqualToString:@"event_msg"]) return nil;
    NSDictionary *payload = root[@"payload"];
    if (![payload isKindOfClass:NSDictionary.class] || ![payload[@"type"] isEqualToString:@"user_message"]) return nil;
    return CPCleanPrompt(payload[@"message"]);
}

static NSString *CPCleanError(NSDictionary *payload) {
    id raw = payload[@"message"] ?: payload[@"error"];
    if ([raw isKindOfClass:NSDictionary.class]) raw = raw[@"message"];
    if (![raw isKindOfClass:NSString.class]) return nil;
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"\\s+" options:0 error:nil];
    NSString *clean = [regex stringByReplacingMatchesInString:raw
                                                      options:0
                                                        range:NSMakeRange(0, [raw length])
                                                 withTemplate:@" "];
    clean = [clean stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return clean.length > 160 ? [[clean substringToIndex:160] stringByAppendingString:@"…"] : clean;
}

static BOOL CPNeedsAttention(NSDictionary *call,
                             NSString *approvalMode,
                             BOOL hasWorkingChild,
                             NSDate *now) {
    NSString *name = [call[@"name"] lowercaseString];
    id startedAt = call[@"startedAt"];
    if ([startedAt isKindOfClass:NSDate.class] && [now timeIntervalSinceDate:startedAt] < 1.2) return NO;
    if ([name containsString:@"request_user_input"] || [name containsString:@"requestpermission"]) return YES;
    if ([[approvalMode lowercaseString] isEqualToString:@"never"] || hasWorkingChild) return NO;
    for (NSString *needle in @[@"exec", @"shell", @"apply_patch", @"write", @"permission", @"mcp"]) {
        if ([name containsString:needle]) return YES;
    }
    return NO;
}

static NSString *CPAttentionDetail(NSString *toolName) {
    NSString *name = toolName.lowercaseString;
    if ([name containsString:@"request_user_input"]) return @"Codex 正在等待你的选择";
    if ([name containsString:@"permission"]) return @"Codex 正在请求权限";
    if ([name containsString:@"apply_patch"] || [name containsString:@"write"]) return @"文件修改等待确认";
    if ([name containsString:@"mcp"]) return @"外部工具调用等待确认";
    return @"命令执行等待确认";
}

@end
