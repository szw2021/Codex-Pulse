#import "CodexRemoteScanner.h"
#include <glob.h>

static NSString * const CPRemoteScannerErrorDomain = @"dev.local.codex-pulse.remote-scanner";

static NSString * _Nullable CPRemoteCleanString(id value);
static NSArray<NSString *> *CPSSHConfigTokens(NSString *line);
static void CPCollectSSHHosts(NSURL *configURL,
                              NSMutableArray<NSString *> *hosts,
                              NSMutableSet<NSString *> *hostKeys,
                              NSMutableSet<NSString *> *visitedPaths,
                              NSUInteger depth);

@implementation CodexRemoteScanner

+ (BOOL)isValidHost:(NSString *)host {
    if (![host isKindOfClass:NSString.class] || host.length == 0 || host.length > 255 ||
        [host hasPrefix:@"-"]) return NO;
    NSRegularExpression *regex = [NSRegularExpression
        regularExpressionWithPattern:@"^[A-Za-z0-9][A-Za-z0-9._:@-]*$" options:0 error:nil];
    return [regex firstMatchInString:host options:0 range:NSMakeRange(0, host.length)] != nil;
}

+ (NSArray<NSString *> *)discoverSSHHosts {
    NSURL *configURL = [NSURL fileURLWithPath:
        [NSHomeDirectory() stringByAppendingPathComponent:@".ssh/config"]];
    return [self hostsFromSSHConfigAtURL:configURL];
}

+ (NSArray<NSString *> *)hostsFromSSHConfigAtURL:(NSURL *)configURL {
    NSMutableArray<NSString *> *hosts = [NSMutableArray array];
    NSMutableSet<NSString *> *hostKeys = [NSMutableSet set];
    NSMutableSet<NSString *> *visitedPaths = [NSMutableSet set];
    CPCollectSSHHosts(configURL, hosts, hostKeys, visitedPaths, 0);
    return hosts;
}

- (NSArray<NSDictionary *> *)scanHost:(NSString *)host error:(NSError **)error {
    if (![CodexRemoteScanner isValidHost:host]) {
        if (error) {
            *error = [NSError errorWithDomain:CPRemoteScannerErrorDomain
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey:@"SSH 主机名格式无效"}];
        }
        return @[];
    }

    NSURL *scriptURL = [NSBundle.mainBundle URLForResource:@"remote_scanner"
                                              withExtension:@"py"
                                               subdirectory:@"Web"];
    NSData *script = scriptURL ? [NSData dataWithContentsOfURL:scriptURL] : nil;
    if (script.length == 0) {
        if (error) {
            *error = [NSError errorWithDomain:CPRemoteScannerErrorDomain
                                         code:2
                                     userInfo:@{NSLocalizedDescriptionKey:@"远程扫描脚本缺失"}];
        }
        return @[];
    }

    NSTask *task = [[NSTask alloc] init];
    NSPipe *standardInput = [NSPipe pipe];
    NSPipe *standardOutput = [NSPipe pipe];
    NSPipe *standardError = [NSPipe pipe];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/ssh"];
    task.arguments = @[
        @"-o", @"BatchMode=yes",
        @"-o", @"ConnectTimeout=8",
        @"-o", @"ServerAliveInterval=5",
        @"-o", @"ServerAliveCountMax=1",
        host, @"python3", @"-"
    ];
    task.standardInput = standardInput;
    task.standardOutput = standardOutput;
    task.standardError = standardError;

    NSError *launchError = nil;
    if (![task launchAndReturnError:&launchError]) {
        if (error) {
            *error = [NSError errorWithDomain:CPRemoteScannerErrorDomain
                                         code:3
                                     userInfo:@{NSLocalizedDescriptionKey:
                                                    launchError.localizedDescription ?: @"无法启动 SSH"}];
        }
        return @[];
    }

    [standardInput.fileHandleForWriting writeData:script];
    [standardInput.fileHandleForWriting closeFile];
    NSData *outputData = [standardOutput.fileHandleForReading readDataToEndOfFile];
    NSData *errorData = [standardError.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];

    if (task.terminationStatus != 0) {
        NSString *message = [[NSString alloc] initWithData:errorData encoding:NSUTF8StringEncoding];
        if (message.length == 0) {
            message = [[NSString alloc] initWithData:outputData encoding:NSUTF8StringEncoding];
        }
        message = CPRemoteCleanString(message) ?: @"无法连接远程服务器";
        if (message.length > 500) message = [[message substringToIndex:500] stringByAppendingString:@"…"];
        if (error) {
            *error = [NSError errorWithDomain:CPRemoteScannerErrorDomain
                                         code:4
                                     userInfo:@{NSLocalizedDescriptionKey:message}];
        }
        return @[];
    }

    return [CodexRemoteScanner sessionsFromJSONData:outputData host:host error:error];
}

+ (NSArray<NSDictionary *> *)sessionsFromJSONData:(NSData *)data
                                               host:(NSString *)host
                                              error:(NSError **)error {
    NSError *jsonError = nil;
    id root = data.length > 0
        ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError]
        : nil;
    if (!root && data.length > 0) {
        NSString *output = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        NSArray<NSString *> *lines = [output componentsSeparatedByCharactersInSet:
            NSCharacterSet.newlineCharacterSet];
        for (NSInteger index = (NSInteger)lines.count - 1; index >= 0; index--) {
            NSData *line = [lines[index] dataUsingEncoding:NSUTF8StringEncoding];
            id candidate = line.length > 0
                ? [NSJSONSerialization JSONObjectWithData:line options:0 error:nil]
                : nil;
            if ([candidate isKindOfClass:NSDictionary.class] &&
                [candidate[@"sessions"] isKindOfClass:NSArray.class]) {
                root = candidate;
                break;
            }
        }
    }
    NSArray *items = nil;
    if ([root isKindOfClass:NSArray.class]) {
        items = root;
    } else if ([root isKindOfClass:NSDictionary.class] &&
               [root[@"sessions"] isKindOfClass:NSArray.class]) {
        items = root[@"sessions"];
    }
    if (!items) {
        if (error) {
            *error = [NSError errorWithDomain:CPRemoteScannerErrorDomain
                                         code:5
                                     userInfo:@{NSLocalizedDescriptionKey:
                                                    jsonError.localizedDescription ?: @"远程服务器返回了无法识别的数据"}];
        }
        return @[];
    }

    NSMutableArray<NSDictionary *> *sessions = [NSMutableArray arrayWithCapacity:items.count];
    for (id item in items) {
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSString *sessionID = CPRemoteCleanString(item[@"id"]);
        if (sessionID.length == 0) continue;
        NSMutableDictionary *session = [item mutableCopy];
        session[@"remoteSessionId"] = sessionID;
        session[@"id"] = [NSString stringWithFormat:@"remote:%@:%@", host, sessionID];
        session[@"shortId"] = [sessionID substringToIndex:MIN((NSUInteger)8, sessionID.length)];
        session[@"source"] = @"remote";
        session[@"remoteHost"] = host;
        session[@"cwd"] = CPRemoteCleanString(session[@"cwd"]) ?: @"";
        session[@"projectName"] = CPRemoteCleanString(session[@"projectName"])
            ?: [NSURL fileURLWithPath:session[@"cwd"]].lastPathComponent ?: @"远程目录";
        session[@"lastPrompt"] = CPRemoteCleanString(session[@"lastPrompt"])
            ?: CPRemoteCleanString(session[@"title"])
            ?: [NSString stringWithFormat:@"Codex 会话 %@", session[@"shortId"]];
        session[@"title"] = CPRemoteCleanString(session[@"title"]) ?: session[@"lastPrompt"];
        session[@"state"] = CPRemoteCleanString(session[@"state"]) ?: @"completed";
        session[@"detail"] = CPRemoteCleanString(session[@"detail"]) ?: @"远程会话";
        if (![session[@"updatedAt"] isKindOfClass:NSNumber.class]) {
            session[@"updatedAt"] = @([NSDate.date timeIntervalSince1970] * 1000.0);
        }

        NSString *completionToken = CPRemoteCleanString(item[@"completionToken"]);
        [session removeObjectForKey:@"completionToken"];
        if (completionToken.length > 0 && [session[@"state"] isEqualToString:@"completed"]) {
            session[@"completionKey"] = [NSString stringWithFormat:@"remote:%@:%@:%@",
                                          host, sessionID, completionToken];
        }
        [sessions addObject:session];
    }
    return sessions;
}

@end

static NSString *CPRemoteCleanString(id value) {
    if (![value isKindOfClass:NSString.class]) return nil;
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"\\s+"
                                                                             options:0 error:nil];
    NSString *clean = [regex stringByReplacingMatchesInString:value
                                                      options:0
                                                        range:NSMakeRange(0, [value length])
                                                 withTemplate:@" "];
    clean = [clean stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (clean.length == 0) return nil;
    return clean.length > 500 ? [[clean substringToIndex:500] stringByAppendingString:@"…"] : clean;
}

static NSArray<NSString *> *CPSSHConfigTokens(NSString *line) {
    NSMutableArray<NSString *> *tokens = [NSMutableArray array];
    NSMutableString *current = [NSMutableString string];
    BOOL singleQuoted = NO;
    BOOL doubleQuoted = NO;
    BOOL escaped = NO;
    for (NSUInteger index = 0; index < line.length; index++) {
        unichar character = [line characterAtIndex:index];
        if (escaped) {
            [current appendFormat:@"%C", character];
            escaped = NO;
            continue;
        }
        if (character == '\\' && !singleQuoted) {
            escaped = YES;
        } else if (character == '\'' && !doubleQuoted) {
            singleQuoted = !singleQuoted;
        } else if (character == '"' && !singleQuoted) {
            doubleQuoted = !doubleQuoted;
        } else if (character == '#' && !singleQuoted && !doubleQuoted) {
            break;
        } else if ([[NSCharacterSet whitespaceCharacterSet] characterIsMember:character] &&
                   !singleQuoted && !doubleQuoted) {
            if (current.length > 0) {
                [tokens addObject:current.copy];
                [current setString:@""];
            }
        } else {
            [current appendFormat:@"%C", character];
        }
    }
    if (escaped) [current appendString:@"\\"];
    if (current.length > 0) [tokens addObject:current.copy];
    return tokens;
}

static void CPCollectSSHHosts(NSURL *configURL,
                              NSMutableArray<NSString *> *hosts,
                              NSMutableSet<NSString *> *hostKeys,
                              NSMutableSet<NSString *> *visitedPaths,
                              NSUInteger depth) {
    if (depth > 12 || !configURL.isFileURL) return;
    NSString *path = configURL.URLByStandardizingPath.URLByResolvingSymlinksInPath.path;
    if (path.length == 0 || [visitedPaths containsObject:path]) return;
    [visitedPaths addObject:path];

    NSString *contents = [NSString stringWithContentsOfFile:path
                                                   encoding:NSUTF8StringEncoding
                                                      error:nil];
    if (contents.length == 0) return;
    NSURL *baseURL = [NSURL fileURLWithPath:path].URLByDeletingLastPathComponent;
    for (NSString *line in [contents componentsSeparatedByCharactersInSet:
                            NSCharacterSet.newlineCharacterSet]) {
        NSMutableArray<NSString *> *tokens = [CPSSHConfigTokens(line) mutableCopy];
        if (tokens.count == 0) continue;
        NSString *keyword = tokens.firstObject;
        NSRange equals = [keyword rangeOfString:@"="];
        if (equals.location != NSNotFound) {
            NSString *firstValue = [keyword substringFromIndex:NSMaxRange(equals)];
            keyword = [keyword substringToIndex:equals.location];
            [tokens removeObjectAtIndex:0];
            if (firstValue.length > 0) [tokens insertObject:firstValue atIndex:0];
        } else {
            [tokens removeObjectAtIndex:0];
        }

        if ([keyword caseInsensitiveCompare:@"Host"] == NSOrderedSame) {
            for (NSString *host in tokens) {
                NSString *key = host.lowercaseString;
                if ([CodexRemoteScanner isValidHost:host] && ![hostKeys containsObject:key]) {
                    [hostKeys addObject:key];
                    [hosts addObject:host];
                }
            }
        } else if ([keyword caseInsensitiveCompare:@"Include"] == NSOrderedSame) {
            for (NSString *pattern in tokens) {
                NSString *expanded = [pattern stringByExpandingTildeInPath];
                if (![expanded isAbsolutePath]) {
                    expanded = [baseURL.path stringByAppendingPathComponent:expanded];
                }
                glob_t matches = {0};
                if (glob(expanded.fileSystemRepresentation, GLOB_TILDE, NULL, &matches) == 0) {
                    for (size_t index = 0; index < matches.gl_pathc; index++) {
                        NSString *includedPath = [NSString stringWithUTF8String:matches.gl_pathv[index]];
                        if (includedPath.length > 0) {
                            CPCollectSSHHosts([NSURL fileURLWithPath:includedPath],
                                              hosts, hostKeys, visitedPaths, depth + 1);
                        }
                    }
                }
                globfree(&matches);
            }
        }
    }
}
