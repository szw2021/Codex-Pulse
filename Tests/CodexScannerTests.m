#import <Foundation/Foundation.h>
#import "AppDelegate.h"
#import "CodexRemoteScanner.h"
#import "CodexScanner.h"

@interface CodexScanner (PromptTesting)
- (NSString *)latestUserPromptAtPath:(NSString *)path afterOffset:(unsigned long long)lowerBound;
@end

static NSDate *TestNow(void) {
    return [NSDate dateWithTimeIntervalSince1970:2000000000];
}

static NSString *Timestamp(NSDate *date) {
    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    return [formatter stringFromDate:date];
}

static NSString *JSONLine(NSString *outerType, NSDictionary *payload, NSDate *date) {
    NSDictionary *event = @{ @"timestamp": Timestamp(date), @"type": outerType, @"payload": payload };
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:NSJSONWritingSortedKeys error:nil];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static NSString *Event(NSString *type, NSTimeInterval secondsAgo) {
    return JSONLine(@"event_msg", @{ @"type": type }, [TestNow() dateByAddingTimeInterval:-secondsAgo]);
}

static NSString *UserMessage(NSString *message, NSTimeInterval secondsAgo) {
    return JSONLine(@"event_msg",
                    @{ @"type": @"user_message", @"message": message },
                    [TestNow() dateByAddingTimeInterval:-secondsAgo]);
}

static NSString *ToolCall(NSString *name, NSTimeInterval secondsAgo) {
    return JSONLine(@"response_item",
                    @{ @"type": @"function_call", @"call_id": @"call-1", @"name": name },
                    [TestNow() dateByAddingTimeInterval:-secondsAgo]);
}

static NSString *ToolOutput(NSTimeInterval secondsAgo) {
    return JSONLine(@"response_item",
                    @{ @"type": @"function_call_output", @"call_id": @"call-1", @"output": @"ok" },
                    [TestNow() dateByAddingTimeInterval:-secondsAgo]);
}

static NSDictionary *Detect(NSArray<NSString *> *lines,
                            NSString *approvalMode,
                            NSDictionary *processInfo,
                            NSTimeInterval modifiedAgo) {
    NSData *data = [[lines componentsJoinedByString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    return [CodexScanner detectStateInData:data
                              approvalMode:approvalMode
                                processInfo:processInfo
                             fileModifiedAt:[TestNow() dateByAddingTimeInterval:-modifiedAgo]
                                        now:TestNow()];
}

static void Check(NSString *name, NSString *expected, NSDictionary *result, NSMutableArray *failures) {
    NSString *actual = result[@"state"];
    if (![actual isEqualToString:expected]) {
        [failures addObject:[NSString stringWithFormat:@"%@: expected %@, got %@", name, expected, actual]];
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSDictionary *idleProcess = @{ @"pid": @7, @"hasWorkingChild": @NO };
        NSDictionary *workingProcess = @{ @"pid": @7, @"hasWorkingChild": @YES };
        NSMutableArray<NSString *> *failures = [NSMutableArray array];

        Check(@"active", @"active",
              Detect(@[Event(@"task_started", 5)], @"never", idleProcess, 5), failures);
        Check(@"completed", @"completed",
              Detect(@[Event(@"task_started", 10), Event(@"task_complete", 1)],
                     @"on-request", idleProcess, 1), failures);
        Check(@"aborted", @"failed",
              Detect(@[Event(@"task_started", 10), Event(@"turn_aborted", 1)],
                     @"on-request", idleProcess, 1), failures);
        Check(@"approval", @"attention",
              Detect(@[Event(@"task_started", 10), ToolCall(@"exec_command", 5)],
                     @"on-request", idleProcess, 5), failures);
        Check(@"running command", @"active",
              Detect(@[Event(@"task_started", 10), ToolCall(@"exec_command", 5)],
                     @"on-request", workingProcess, 5), failures);
        Check(@"request user input", @"attention",
              Detect(@[Event(@"task_started", 10), ToolCall(@"request_user_input", 5)],
                     @"never", idleProcess, 5), failures);
        Check(@"unexpected stop", @"failed",
              Detect(@[Event(@"task_started", 30)], @"never", nil, 30), failures);
        Check(@"completed tool call", @"active",
              Detect(@[Event(@"task_started", 10), ToolCall(@"exec_command", 5), ToolOutput(4)],
                     @"on-request", idleProcess, 4), failures);
        Check(@"previous turn tool ignored", @"active",
              Detect(@[ToolCall(@"exec_command", 20), Event(@"task_started", 5)],
                     @"on-request", idleProcess, 5), failures);
        Check(@"approval grace period", @"active",
              Detect(@[Event(@"task_started", 2), ToolCall(@"exec_command", 0.5)],
                     @"on-request", idleProcess, 0.5), failures);
        Check(@"error", @"failed",
              Detect(@[Event(@"task_started", 10), Event(@"error", 1)],
                     @"never", idleProcess, 1), failures);

        NSDictionary *completedPrompt = Detect(@[
            Event(@"task_started", 10),
            UserMessage(@"  第一行\n第二行  ", 9),
            Event(@"task_complete", 1)
        ], @"never", idleProcess, 1);
        if (![completedPrompt[@"lastPrompt"] isEqualToString:@"第一行 第二行"]) {
            [failures addObject:[NSString stringWithFormat:@"completed prompt is incorrect: %@", completedPrompt[@"lastPrompt"]]];
        }

        NSDictionary *completionIdentity = Detect(@[
            Event(@"task_started", 10),
            JSONLine(@"event_msg",
                     @{ @"type": @"task_complete", @"turn_id": @"turn-complete-123" },
                     [TestNow() dateByAddingTimeInterval:-1])
        ], @"never", idleProcess, 1);
        if (![completionIdentity[@"completionToken"] isEqualToString:@"turn-complete-123"]) {
            [failures addObject:[NSString stringWithFormat:@"completion token is incorrect: %@",
                                 completionIdentity[@"completionToken"]]];
        }

        NSDictionary *latestPrompt = Detect(@[
            Event(@"task_started", 20), UserMessage(@"旧提示词", 19), Event(@"task_complete", 15),
            Event(@"task_started", 5), UserMessage(@"最新提示词", 4)
        ], @"never", idleProcess, 4);
        if (![latestPrompt[@"lastPrompt"] isEqualToString:@"最新提示词"]) {
            [failures addObject:[NSString stringWithFormat:@"latest prompt is incorrect: %@", latestPrompt[@"lastPrompt"]]];
        }

        NSString *promptFixture = [NSTemporaryDirectory()
            stringByAppendingPathComponent:[NSString stringWithFormat:@"codex-pulse-prompt-%@.jsonl", NSUUID.UUID.UUIDString]];
        NSMutableData *fixtureData = [NSMutableData data];
        [fixtureData appendData:[[UserMessage(@"跨块旧提示词", 20) stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
        NSData *fillerLine = [[JSONLine(@"event_msg", @{ @"type": @"token_count" }, TestNow()) stringByAppendingString:@"\n"]
            dataUsingEncoding:NSUTF8StringEncoding];
        while (fixtureData.length < 700000) [fixtureData appendData:fillerLine];
        [fixtureData writeToFile:promptFixture atomically:YES];

        CodexScanner *promptScanner = [[CodexScanner alloc]
            initWithCodexHome:[NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES]];
        NSString *crossChunkPrompt = [promptScanner latestUserPromptAtPath:promptFixture afterOffset:0];
        if (![crossChunkPrompt isEqualToString:@"跨块旧提示词"]) {
            [failures addObject:[NSString stringWithFormat:@"cross-chunk prompt is incorrect: %@", crossChunkPrompt]];
        }

        unsigned long long previousSize = fixtureData.length;
        [fixtureData appendData:[[UserMessage(@"增量最新提示词", 1) stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
        [fixtureData appendData:fillerLine];
        [fixtureData writeToFile:promptFixture atomically:YES];
        NSString *incrementalPrompt = [promptScanner latestUserPromptAtPath:promptFixture afterOffset:previousSize];
        if (![incrementalPrompt isEqualToString:@"增量最新提示词"]) {
            [failures addObject:[NSString stringWithFormat:@"incremental prompt is incorrect: %@", incrementalPrompt]];
        }
        [NSFileManager.defaultManager removeItemAtPath:promptFixture error:nil];

        NSDictionary *resumeSession = @{ @"cwd": @"/tmp/demo folder", @"id": @"abc-123" };
        NSString *safeCommand = [AppDelegate resumeCommandForSession:resumeSession yoloEnabled:NO];
        NSString *yoloCommand = [AppDelegate resumeCommandForSession:resumeSession yoloEnabled:YES];
        if (![safeCommand isEqualToString:@"cd '/tmp/demo folder' && codex resume 'abc-123'"]) {
            [failures addObject:[NSString stringWithFormat:@"safe resume command is incorrect: %@", safeCommand]];
        }
        if (![yoloCommand isEqualToString:@"cd '/tmp/demo folder' && codex resume --dangerously-bypass-approvals-and-sandbox 'abc-123'"]) {
            [failures addObject:[NSString stringWithFormat:@"YOLO resume command is incorrect: %@", yoloCommand]];
        }
        NSDictionary *remoteResumeSession = @{
            @"cwd": @"/srv/demo folder", @"remoteSessionId": @"abc-123", @"remoteHost": @"dev-box"
        };
        NSString *remoteSafeCommand = [AppDelegate remoteResumeCommandForSession:remoteResumeSession yoloEnabled:NO];
        NSString *remoteYoloCommand = [AppDelegate remoteResumeCommandForSession:remoteResumeSession yoloEnabled:YES];
        if (![remoteSafeCommand isEqualToString:@"ssh -t 'dev-box' 'cd '\\''/srv/demo folder'\\'' && codex resume '\\''abc-123'\\'''" ]) {
            [failures addObject:[NSString stringWithFormat:@"remote resume command is incorrect: %@", remoteSafeCommand]];
        }
        if (![remoteYoloCommand containsString:@"--dangerously-bypass-approvals-and-sandbox"] ||
            ![remoteYoloCommand hasPrefix:@"ssh -t 'dev-box' "]) {
            [failures addObject:[NSString stringWithFormat:@"remote YOLO command is incorrect: %@", remoteYoloCommand]];
        }

        NSTimeInterval trackingStartedAt = 2000.0;
        NSArray *completionFixtures = @[
            @{ @"id": @"attention", @"state": @"attention", @"updatedAt": @2009000 },
            @{ @"id": @"old", @"state": @"completed", @"updatedAt": @1999000,
               @"completionKey": @"old:key" },
            @{ @"id": @"new", @"state": @"completed", @"updatedAt": @2008000,
               @"completionKey": @"new:key" },
            @{ @"id": @"acked", @"state": @"completed", @"updatedAt": @2007000,
               @"completionKey": @"acked:key" },
            @{ @"id": @"failed", @"state": @"failed", @"updatedAt": @2010000 },
            @{ @"id": @"active", @"state": @"active", @"updatedAt": @2006000 }
        ];
        NSArray *tracked = [AppDelegate sessionsByApplyingCompletionTracking:completionFixtures
                                                            trackingStartedAt:trackingStartedAt
                                                      acknowledgedCompletions:[NSSet setWithObject:@"acked:key"]];
        NSArray *trackedStates = [tracked valueForKey:@"state"];
        NSArray *expectedTrackedStates = @[@"active", @"completed_pending", @"completed",
                                           @"completed", @"attention", @"failed"];
        if (![trackedStates isEqualToArray:expectedTrackedStates] ||
            ![tracked[1][@"id"] isEqualToString:@"new"]) {
            [failures addObject:[NSString stringWithFormat:@"completion tracking order is incorrect: %@",
                                 tracked]];
        }
        NSArray *acknowledged = [AppDelegate sessionsByApplyingCompletionTracking:completionFixtures
                                                                  trackingStartedAt:trackingStartedAt
                                                            acknowledgedCompletions:[NSSet setWithArray:@[@"acked:key", @"new:key"]]];
        if ([[acknowledged valueForKey:@"state"] containsObject:@"completed_pending"]) {
            [failures addObject:@"acknowledged completion remained pending"];
        }

        NSDictionary *remoteFixture = @{
            @"sessions": @[
                @{
                    @"id": @"remote-session-123", @"title": @"远程标题",
                    @"lastPrompt": @"服务器上的最后提示词", @"cwd": @"/srv/project",
                    @"projectName": @"project", @"state": @"completed",
                    @"detail": @"本轮任务已完成", @"updatedAt": @2008000,
                    @"completionToken": @"turn-remote-9", @"model": @"gpt-test"
                },
                @{
                    @"id": @"remote-failed", @"title": @"失败任务", @"lastPrompt": @"检查失败",
                    @"cwd": @"/srv/failed", @"state": @"failed", @"detail": @"已停止",
                    @"updatedAt": @2000000
                }
            ]
        };
        NSData *remoteData = [NSJSONSerialization dataWithJSONObject:remoteFixture options:0 error:nil];
        NSError *remoteParseError = nil;
        NSArray *remoteSessions = [CodexRemoteScanner sessionsFromJSONData:remoteData
                                                                       host:@"dev-box"
                                                                      error:&remoteParseError];
        NSDictionary *remoteSession = remoteSessions.firstObject;
        if (remoteParseError || remoteSessions.count != 2 ||
            ![remoteSession[@"id"] isEqualToString:@"remote:dev-box:remote-session-123"] ||
            ![remoteSession[@"lastPrompt"] isEqualToString:@"服务器上的最后提示词"] ||
            ![remoteSession[@"remoteHost"] isEqualToString:@"dev-box"] ||
            ![remoteSession[@"completionKey"] isEqualToString:@"remote:dev-box:remote-session-123:turn-remote-9"]) {
            [failures addObject:[NSString stringWithFormat:@"remote session parsing is incorrect: %@ (%@)",
                                 remoteSessions, remoteParseError]];
        }
        if (![CodexRemoteScanner isValidHost:@"user@dev-box"] ||
            [CodexRemoteScanner isValidHost:@"-oProxyCommand=bad"] ||
            [CodexRemoteScanner isValidHost:@"host with spaces"]) {
            [failures addObject:@"remote host validation is incorrect"];
        }

        NSString *sshFixtureRoot = [NSTemporaryDirectory()
            stringByAppendingPathComponent:[NSString stringWithFormat:@"codex-pulse-ssh-%@", NSUUID.UUID.UUIDString]];
        NSString *includeRoot = [sshFixtureRoot stringByAppendingPathComponent:@"conf.d"];
        [NSFileManager.defaultManager createDirectoryAtPath:includeRoot
                                withIntermediateDirectories:YES attributes:nil error:nil];
        NSString *sshConfigPath = [sshFixtureRoot stringByAppendingPathComponent:@"config"];
        NSString *includedPath = [includeRoot stringByAppendingPathComponent:@"servers.conf"];
        NSString *loopPath = [sshFixtureRoot stringByAppendingPathComponent:@"loop.conf"];
        [@"Host dev-box prod-box *.internal !disabled\nHost=equal-box\nInclude \"conf.d/*.conf\"\n"
            writeToFile:sshConfigPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
        [@"Host gpu-node user@edge # comment\nInclude ../loop.conf\n"
            writeToFile:includedPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
        [@"Include config\n" writeToFile:loopPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
        NSArray *discoveredHosts = [CodexRemoteScanner hostsFromSSHConfigAtURL:
            [NSURL fileURLWithPath:sshConfigPath]];
        NSArray *expectedHosts = @[@"dev-box", @"prod-box", @"equal-box", @"gpu-node", @"user@edge"];
        if (![discoveredHosts isEqualToArray:expectedHosts]) {
            [failures addObject:[NSString stringWithFormat:@"SSH config discovery is incorrect: %@",
                                 discoveredHosts]];
        }
        [NSFileManager.defaultManager removeItemAtPath:sshFixtureRoot error:nil];

        NSString *codexHome = NSProcessInfo.processInfo.environment[@"CODEX_HOME"];
        if (codexHome.length == 0) codexHome = [NSHomeDirectory() stringByAppendingPathComponent:@".codex"];
        NSString *databasePath = [codexHome stringByAppendingPathComponent:@"state_5.sqlite"];
        if ([NSFileManager.defaultManager fileExistsAtPath:databasePath]) {
            NSError *scanError = nil;
            CodexScanner *scanner = [[CodexScanner alloc]
                initWithCodexHome:[NSURL fileURLWithPath:codexHome isDirectory:YES]];
            NSDate *firstStartedAt = NSDate.date;
            NSArray<NSDictionary *> *sessions = [scanner scanSessionsWithError:&scanError];
            NSTimeInterval firstDuration = -[firstStartedAt timeIntervalSinceNow];
            if (scanError) [failures addObject:[NSString stringWithFormat:@"integration scan: %@", scanError.localizedDescription]];

            NSSet *validStates = [NSSet setWithArray:@[@"active", @"attention", @"failed", @"completed"]];
            NSMutableDictionary<NSString *, NSNumber *> *counts = [@{
                @"active": @0, @"attention": @0, @"failed": @0, @"completed": @0
            } mutableCopy];
            for (NSDictionary *session in sessions) {
                NSString *state = session[@"state"];
                if (![session[@"source"] isEqualToString:@"cli"]) {
                    [failures addObject:[NSString stringWithFormat:@"integration scan returned non-CLI source: %@", session[@"source"]]];
                }
                if (![validStates containsObject:state]) {
                    [failures addObject:[NSString stringWithFormat:@"integration scan returned invalid state: %@", state]];
                } else {
                    counts[state] = @([counts[state] integerValue] + 1);
                }
                if ([session[@"lastPrompt"] length] == 0) {
                    [failures addObject:[NSString stringWithFormat:@"integration scan returned no prompt for %@", session[@"id"]]];
                }
            }
            printf("integration scan: %lu sessions (active=%ld attention=%ld failed=%ld completed=%ld)\n",
                   (unsigned long)sessions.count,
                   (long)[counts[@"active"] integerValue],
                   (long)[counts[@"attention"] integerValue],
                   (long)[counts[@"failed"] integerValue],
                   (long)[counts[@"completed"] integerValue]);

            NSDate *cachedStartedAt = NSDate.date;
            NSArray<NSDictionary *> *cachedSessions = [scanner scanSessionsWithError:&scanError];
            NSTimeInterval cachedDuration = -[cachedStartedAt timeIntervalSinceNow];
            if (scanError) [failures addObject:[NSString stringWithFormat:@"cached integration scan: %@", scanError.localizedDescription]];
            if (cachedSessions.count != sessions.count) {
                [failures addObject:@"cached integration scan changed the number of sessions"];
            }
            printf("scan timing: first=%.3fs cached=%.3fs\n", firstDuration, cachedDuration);
        }

        if (failures.count > 0) {
            for (NSString *failure in failures) fprintf(stderr, "FAIL: %s\n", failure.UTF8String);
            return 1;
        }
        printf("11 scanner state tests, 5 prompt/completion tests, 2 completion-flow tests, "
               "3 remote/SSH parsing tests, and 4 resume command tests passed\n");
    }
    return 0;
}
