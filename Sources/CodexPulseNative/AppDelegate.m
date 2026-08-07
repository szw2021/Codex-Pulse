#import "AppDelegate.h"
#import "CodexRemoteScanner.h"
#import "CodexScanner.h"
#import <WebKit/WebKit.h>
#include <string.h>

static NSString *CPShellQuote(NSString *value);
static NSString *CPAppleScriptString(NSString *value);
static NSString * const CPYOLOModeDefaultsKey = @"CodexPulseYOLOModeEnabled";
static NSString * const CPCompletionTrackingStartedAtDefaultsKey = @"CodexPulseCompletionTrackingStartedAt";
static NSString * const CPAcknowledgedCompletionsDefaultsKey = @"CodexPulseAcknowledgedCompletions";
static NSString * const CPRemoteHostsDefaultsKey = @"CodexPulseRemoteHosts";

@interface CPPanel : NSPanel
@end

@implementation CPPanel
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface AppDelegate () <WKNavigationDelegate, WKScriptMessageHandler>
@property(nonatomic, strong) CodexScanner *scanner;
@property(nonatomic, strong) CodexRemoteScanner *remoteScanner;
@property(nonatomic, strong) CPPanel *panel;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSStatusItem *statusItem;
@property(nonatomic, strong) NSTimer *refreshTimer;
@property(nonatomic, copy) NSDictionary<NSString *, NSDictionary *> *sessionsByID;
@property(nonatomic, copy) NSArray<NSDictionary *> *localSessions;
@property(nonatomic, copy) NSArray<NSDictionary *> *remoteSessions;
@property(nonatomic, copy) NSArray<NSString *> *remoteHosts;
@property(nonatomic, copy) NSArray<NSString *> *discoveredRemoteHosts;
@property(nonatomic, copy) NSDictionary<NSString *, NSString *> *remoteErrors;
@property(nonatomic, strong, nullable) NSError *localError;
@property(nonatomic, copy, nullable) NSString *remoteConfigError;
@property(nonatomic, strong, nullable) NSDate *remoteRefreshedAt;
@property(nonatomic, strong) NSMutableSet<NSString *> *acknowledgedCompletions;
@property(nonatomic) BOOL refreshInFlight;
@property(nonatomic) BOOL remoteRefreshInFlight;
@property(nonatomic) BOOL pageReady;
@property(nonatomic) BOOL yoloEnabled;
@property(nonatomic) BOOL viewingRemote;
@property(nonatomic) NSUInteger remoteRefreshGeneration;
@property(nonatomic) NSTimeInterval completionTrackingStartedAt;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSLog(@"Codex Pulse did finish launching");
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    const char *configuredHome = getenv("CODEX_HOME");
    NSString *home = configuredHome && strlen(configuredHome) > 0
        ? [NSString stringWithUTF8String:configuredHome]
        : [NSHomeDirectory() stringByAppendingPathComponent:@".codex"];
    self.scanner = [[CodexScanner alloc] initWithCodexHome:[NSURL fileURLWithPath:home isDirectory:YES]];
    self.remoteScanner = [[CodexRemoteScanner alloc] init];
    self.sessionsByID = @{};
    self.localSessions = @[];
    self.remoteSessions = @[];
    self.remoteErrors = @{};
    self.discoveredRemoteHosts = [CodexRemoteScanner discoverSSHHosts];
    self.yoloEnabled = [NSUserDefaults.standardUserDefaults boolForKey:CPYOLOModeDefaultsKey];

    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    self.completionTrackingStartedAt = [defaults doubleForKey:CPCompletionTrackingStartedAtDefaultsKey];
    if (self.completionTrackingStartedAt <= 0) {
        self.completionTrackingStartedAt = [NSDate.date timeIntervalSince1970];
        [defaults setDouble:self.completionTrackingStartedAt forKey:CPCompletionTrackingStartedAtDefaultsKey];
    }
    NSArray *storedCompletions = [defaults arrayForKey:CPAcknowledgedCompletionsDefaultsKey];
    self.acknowledgedCompletions = [NSMutableSet setWithArray:storedCompletions ?: @[]];
    NSArray *storedHosts = [defaults arrayForKey:CPRemoteHostsDefaultsKey];
    NSMutableArray<NSString *> *validHosts = [NSMutableArray array];
    for (id host in storedHosts ?: @[]) {
        if ([CodexRemoteScanner isValidHost:host] && ![validHosts containsObject:host]) {
            [validHosts addObject:host];
        }
    }
    self.remoteHosts = validHosts;

    [self configureStatusItem];
    [self configurePanel];
    self.refreshTimer = [NSTimer scheduledTimerWithTimeInterval:2.0
                                                         target:self
                                                       selector:@selector(refreshSessions)
                                                       userInfo:nil
                                                        repeats:YES];
    [self refreshSessions];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return NO;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [self.refreshTimer invalidate];
    [self.webView.configuration.userContentController removeScriptMessageHandlerForName:@"codexPulse"];
}

- (void)configureStatusItem {
    self.statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    NSStatusBarButton *button = self.statusItem.button;
    button.image = [NSImage imageWithSystemSymbolName:@"terminal.fill"
                            accessibilityDescription:@"Codex Pulse"];
    button.imagePosition = NSImageLeading;
    button.toolTip = @"Codex Pulse";
    button.target = self;
    button.action = @selector(togglePanel:);
}

- (void)configurePanel {
    self.panel = [[CPPanel alloc] initWithContentRect:NSMakeRect(0, 0, 410, 640)
                                           styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                             backing:NSBackingStoreBuffered
                                               defer:NO];
    self.panel.level = NSFloatingWindowLevel;
    self.panel.opaque = NO;
    self.panel.backgroundColor = NSColor.clearColor;
    self.panel.hasShadow = YES;
    self.panel.sharingType = NSWindowSharingReadOnly;
    self.panel.movableByWindowBackground = YES;
    self.panel.hidesOnDeactivate = NO;
    self.panel.collectionBehavior = NSWindowCollectionBehaviorMoveToActiveSpace |
                                    NSWindowCollectionBehaviorFullScreenAuxiliary;

    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    [configuration.userContentController addScriptMessageHandler:self name:@"codexPulse"];
    NSView *container = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 410, 640)];
    container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView = [[WKWebView alloc] initWithFrame:container.bounds configuration:configuration];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.navigationDelegate = self;
    self.webView.underPageBackgroundColor = NSColor.clearColor;
    self.webView.layer.cornerRadius = 24.0;
    self.webView.layer.masksToBounds = YES;
    [container addSubview:self.webView];
    self.panel.contentView = container;

    NSURL *indexURL = [NSBundle.mainBundle URLForResource:@"index"
                                            withExtension:@"html"
                                             subdirectory:@"Web"];
    if (indexURL) {
        [self.webView loadFileURL:indexURL allowingReadAccessToURL:indexURL.URLByDeletingLastPathComponent];
    } else {
        [self.webView loadHTMLString:@"<h3 style='color:white'>Codex Pulse 资源缺失</h3>" baseURL:nil];
    }

    NSScreen *screen = NSScreen.mainScreen;
    if (screen) {
        NSRect frame = screen.visibleFrame;
        [self.panel setFrameOrigin:NSMakePoint(NSMaxX(frame) - self.panel.frame.size.width - 18,
                                               NSMaxY(frame) - self.panel.frame.size.height - 18)];
    } else {
        [self.panel center];
    }
    [NSApp activateIgnoringOtherApps:YES];
    [self.panel makeKeyAndOrderFront:nil];
    NSLog(@"Codex Pulse panel visible=%d number=%ld frame=%@ web=%@",
          self.panel.visible,
          (long)self.panel.windowNumber,
          NSStringFromRect(self.panel.frame),
          NSStringFromRect(self.webView.frame));
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    NSLog(@"Codex Pulse web view ready");
    self.pageReady = YES;
    [self refreshSessions];
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:NSDictionary.class]) return;
    NSDictionary *body = message.body;
    NSString *action = body[@"action"];
    NSString *sessionID = body[@"id"];

    if ([action isEqualToString:@"refresh"]) {
        [self refreshSessions];
    } else if ([action isEqualToString:@"refreshRemote"]) {
        [self refreshRemoteSessions];
    } else if ([action isEqualToString:@"reloadSSHHosts"]) {
        self.discoveredRemoteHosts = [CodexRemoteScanner discoverSSHHosts];
        self.remoteConfigError = nil;
        [self publishState];
    } else if ([action isEqualToString:@"setSource"] && [body[@"source"] isKindOfClass:NSString.class]) {
        self.viewingRemote = [body[@"source"] isEqualToString:@"remote"];
        if (self.viewingRemote) [self refreshRemoteSessions];
    } else if ([action isEqualToString:@"addRemoteHost"]) {
        [self addRemoteHost:body[@"host"]];
    } else if ([action isEqualToString:@"removeRemoteHost"]) {
        [self removeRemoteHost:body[@"host"]];
    } else if ([action isEqualToString:@"remoteConnect"] &&
               [CodexRemoteScanner isValidHost:body[@"host"]]) {
        [self launchTerminalCommand:[NSString stringWithFormat:@"ssh %@", CPShellQuote(body[@"host"])]];
    } else if ([action isEqualToString:@"setYolo"] && [body[@"enabled"] isKindOfClass:NSNumber.class]) {
        self.yoloEnabled = [body[@"enabled"] boolValue];
        [NSUserDefaults.standardUserDefaults setBool:self.yoloEnabled forKey:CPYOLOModeDefaultsKey];
        [self updateStatusItemWithSessions:self.sessionsByID.allValues];
        [self refreshSessions];
    } else if ([action isEqualToString:@"hide"]) {
        [self.panel orderOut:nil];
    } else if ([action isEqualToString:@"quit"]) {
        [NSApp terminate:nil];
    } else if ([action isEqualToString:@"drag"]) {
        NSEvent *event = NSApp.currentEvent;
        if (event.type == NSEventTypeLeftMouseDown) [self.panel performWindowDragWithEvent:event];
    } else if ([sessionID isKindOfClass:NSString.class]) {
        NSDictionary *session = self.sessionsByID[sessionID];
        if (!session) return;
        if ([action isEqualToString:@"resume"]) {
            [self resumeSession:session];
        } else if ([action isEqualToString:@"copy"]) {
            [self copyResumeCommandForSession:session];
        } else if ([action isEqualToString:@"reveal"]) {
            [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:
                @[[NSURL fileURLWithPath:session[@"cwd"]]]];
        } else if ([action isEqualToString:@"acknowledgeCompletion"]) {
            NSString *completionKey = body[@"completionKey"];
            if ([completionKey isKindOfClass:NSString.class] &&
                [completionKey isEqualToString:session[@"completionKey"]]) {
                [self acknowledgeCompletion:completionKey];
            }
        } else if ([session[@"source"] isEqualToString:@"remote"]) {
            if ([action isEqualToString:@"remoteResume"]) {
                [self launchTerminalCommand:[AppDelegate remoteResumeCommandForSession:session
                                                                            yoloEnabled:self.yoloEnabled]];
            } else if ([action isEqualToString:@"remoteCopy"]) {
                NSString *command = [AppDelegate remoteResumeCommandForSession:session
                                                                    yoloEnabled:self.yoloEnabled];
                [NSPasteboard.generalPasteboard clearContents];
                [NSPasteboard.generalPasteboard setString:command forType:NSPasteboardTypeString];
            }
        }
    }
}

- (void)refreshSessions {
    if (self.refreshInFlight) return;
    self.refreshInFlight = YES;
    __weak typeof(self) weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSError *error = nil;
        NSArray<NSDictionary *> *sessions = [weakSelf.scanner scanSessionsWithError:&error];
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) self = weakSelf;
            if (!self) return;
            self.refreshInFlight = NO;

            self.localSessions = sessions;
            self.localError = error;
            [self publishState];
            if (self.viewingRemote &&
                (!self.remoteRefreshedAt || -[self.remoteRefreshedAt timeIntervalSinceNow] >= 15.0)) {
                [self refreshRemoteSessions];
            }
        });
    });
}

- (void)addRemoteHost:(id)value {
    NSString *host = [value isKindOfClass:NSString.class]
        ? [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
        : @"";
    if (![CodexRemoteScanner isValidHost:host]) {
        self.remoteConfigError = @"请输入有效的 SSH 主机或 ~/.ssh/config 别名";
        [self publishState];
        return;
    }
    self.remoteConfigError = nil;
    if (![self.remoteHosts containsObject:host]) {
        self.remoteHosts = [self.remoteHosts arrayByAddingObject:host];
        [NSUserDefaults.standardUserDefaults setObject:self.remoteHosts forKey:CPRemoteHostsDefaultsKey];
    }
    [self restartRemoteRefresh];
}

- (void)removeRemoteHost:(id)value {
    if (![value isKindOfClass:NSString.class] || ![self.remoteHosts containsObject:value]) return;
    NSMutableArray<NSString *> *hosts = [self.remoteHosts mutableCopy];
    [hosts removeObject:value];
    self.remoteHosts = hosts;
    [NSUserDefaults.standardUserDefaults setObject:self.remoteHosts forKey:CPRemoteHostsDefaultsKey];

    NSPredicate *keepOtherHosts = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *session,
                                                                        NSDictionary *bindings) {
        return ![session[@"remoteHost"] isEqualToString:value];
    }];
    self.remoteSessions = [self.remoteSessions filteredArrayUsingPredicate:keepOtherHosts];
    NSMutableDictionary *errors = [self.remoteErrors mutableCopy];
    [errors removeObjectForKey:value];
    self.remoteErrors = errors;
    self.remoteConfigError = nil;
    [self restartRemoteRefresh];
}

- (void)restartRemoteRefresh {
    self.remoteRefreshGeneration++;
    self.remoteRefreshInFlight = NO;
    self.remoteRefreshedAt = nil;
    [self publishState];
    [self refreshRemoteSessions];
}

- (void)refreshRemoteSessions {
    if (self.remoteRefreshInFlight) return;
    NSArray<NSString *> *hosts = self.remoteHosts ?: @[];
    NSUInteger generation = ++self.remoteRefreshGeneration;
    if (hosts.count == 0) {
        self.remoteSessions = @[];
        self.remoteErrors = @{};
        self.remoteRefreshInFlight = NO;
        self.remoteRefreshedAt = NSDate.date;
        [self publishState];
        return;
    }

    self.remoteRefreshInFlight = YES;
    [self publishState];
    CodexRemoteScanner *scanner = self.remoteScanner;
    __weak typeof(self) weakSelf = self;
    dispatch_group_t group = dispatch_group_create();
    dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
    NSMutableArray<NSDictionary *> *allSessions = [NSMutableArray array];
    NSMutableDictionary<NSString *, NSString *> *errors = [NSMutableDictionary dictionary];
    for (NSString *host in hosts) {
        dispatch_group_async(group, queue, ^{
            NSError *error = nil;
            NSArray<NSDictionary *> *sessions = [scanner scanHost:host error:&error];
            @synchronized (allSessions) {
                [allSessions addObjectsFromArray:sessions];
                if (error.localizedDescription.length > 0) errors[host] = error.localizedDescription;
            }
        });
    }
    dispatch_group_notify(group, dispatch_get_main_queue(), ^{
            typeof(self) self = weakSelf;
            if (!self) return;
            if (generation != self.remoteRefreshGeneration) return;
            self.remoteRefreshInFlight = NO;
            self.remoteSessions = allSessions.copy;
            self.remoteErrors = errors.copy;
            self.remoteRefreshedAt = NSDate.date;
            [self publishState];
    });
}

- (NSArray<NSDictionary *> *)sessionsApplyingCompletionTracking:(NSArray<NSDictionary *> *)sessions {
    return [AppDelegate sessionsByApplyingCompletionTracking:sessions
                                           trackingStartedAt:self.completionTrackingStartedAt
                                     acknowledgedCompletions:self.acknowledgedCompletions];
}

+ (NSArray<NSDictionary *> *)sessionsByApplyingCompletionTracking:(NSArray<NSDictionary *> *)sessions
                                                 trackingStartedAt:(NSTimeInterval)trackingStartedAt
                                           acknowledgedCompletions:(NSSet<NSString *> *)acknowledgedCompletions {
    NSMutableArray<NSDictionary *> *result = [NSMutableArray arrayWithCapacity:sessions.count];
    NSTimeInterval baselineMilliseconds = trackingStartedAt * 1000.0;
    for (NSDictionary *session in sessions) {
        NSMutableDictionary *display = [session mutableCopy];
        NSString *completionKey = session[@"completionKey"];
        BOOL isNewCompletion = [session[@"state"] isEqualToString:@"completed"] &&
            [completionKey isKindOfClass:NSString.class] && completionKey.length > 0 &&
            [session[@"updatedAt"] doubleValue] > baselineMilliseconds &&
            ![acknowledgedCompletions containsObject:completionKey];
        if (isNewCompletion) {
            display[@"state"] = @"completed_pending";
            display[@"detail"] = @"任务已完成，等待你确认";
        }
        [result addObject:display];
    }

    NSDictionary<NSString *, NSNumber *> *priority = @{
        @"active": @0,
        @"completed_pending": @1,
        @"completed": @2,
        @"attention": @3,
        @"failed": @4
    };
    [result sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
        NSInteger leftPriority = [priority[left[@"state"]] integerValue];
        NSInteger rightPriority = [priority[right[@"state"]] integerValue];
        if (leftPriority != rightPriority) {
            return leftPriority < rightPriority ? NSOrderedAscending : NSOrderedDescending;
        }
        return [right[@"updatedAt"] compare:left[@"updatedAt"]];
    }];
    return result;
}

- (void)acknowledgeCompletion:(NSString *)completionKey {
    [self.acknowledgedCompletions addObject:completionKey];
    NSArray<NSString *> *stored = [self.acknowledgedCompletions.allObjects
        sortedArrayUsingSelector:@selector(compare:)];
    [NSUserDefaults.standardUserDefaults setObject:stored forKey:CPAcknowledgedCompletionsDefaultsKey];
    [self publishState];
}

- (void)publishState {
    NSArray<NSDictionary *> *local = [self sessionsApplyingCompletionTracking:self.localSessions ?: @[]];
    NSArray<NSDictionary *> *remote = [self sessionsApplyingCompletionTracking:self.remoteSessions ?: @[]];
    NSMutableDictionary *byID = [NSMutableDictionary dictionaryWithCapacity:local.count + remote.count];
    for (NSDictionary *session in local) byID[session[@"id"]] = session;
    for (NSDictionary *session in remote) byID[session[@"id"]] = session;
    self.sessionsByID = byID;

    NSMutableArray *allSessions = [local mutableCopy];
    [allSessions addObjectsFromArray:remote];
    [self updateStatusItemWithSessions:allSessions];
    if (!self.pageReady) return;

    NSDictionary *payload = @{
        @"sessions": local,
        @"remoteSessions": remote,
        @"remoteHosts": self.remoteHosts ?: @[],
        @"discoveredRemoteHosts": self.discoveredRemoteHosts ?: @[],
        @"remoteErrors": self.remoteErrors ?: @{},
        @"remoteConfigError": self.remoteConfigError ?: NSNull.null,
        @"error": self.localError.localizedDescription ?: NSNull.null,
        @"remoteLoading": @(self.remoteRefreshInFlight),
        @"yoloEnabled": @(self.yoloEnabled),
        @"refreshedAt": @([NSDate.date timeIntervalSince1970] * 1000.0),
        @"remoteRefreshedAt": self.remoteRefreshedAt
            ? @([self.remoteRefreshedAt timeIntervalSince1970] * 1000.0)
            : NSNull.null
    };
    [self.webView callAsyncJavaScript:@"window.CodexPulse.receive(payload)"
                             arguments:@{ @"payload": payload }
                               inFrame:nil
                         inContentWorld:WKContentWorld.pageWorld
                      completionHandler:nil];
}

- (void)updateStatusItemWithSessions:(NSArray<NSDictionary *> *)sessions {
    NSUInteger attention = 0;
    NSUInteger active = 0;
    NSUInteger completedPending = 0;
    for (NSDictionary *session in sessions) {
        if ([session[@"state"] isEqualToString:@"attention"]) attention++;
        if ([session[@"state"] isEqualToString:@"active"]) active++;
        if ([session[@"state"] isEqualToString:@"completed_pending"]) completedPending++;
    }
    NSStatusBarButton *button = self.statusItem.button;
    NSMutableString *activityTitle = [NSMutableString string];
    if (attention > 0) [activityTitle appendFormat:@" !%lu", (unsigned long)attention];
    if (completedPending > 0) [activityTitle appendFormat:@" ✓%lu", (unsigned long)completedPending];
    if (attention == 0 && completedPending == 0 && active > 0) {
        [activityTitle appendFormat:@" %lu", (unsigned long)active];
    }
    button.title = self.yoloEnabled
        ? [NSString stringWithFormat:@" YOLO%@", activityTitle]
        : activityTitle;
    if (completedPending > 0) {
        button.toolTip = [NSString stringWithFormat:@"Codex Pulse · %lu 个任务完成待确认%@",
                          (unsigned long)completedPending,
                          self.yoloEnabled ? @" · YOLO 已开启" : @""];
    } else {
        button.toolTip = self.yoloEnabled ? @"Codex Pulse · YOLO 模式已开启" : @"Codex Pulse";
    }
    button.contentTintColor = self.yoloEnabled
        ? NSColor.systemRedColor
        : (attention > 0 ? NSColor.systemOrangeColor
                         : (completedPending > 0 ? NSColor.systemPurpleColor : nil));
}

- (void)resumeSession:(NSDictionary *)session {
    NSString *command = [AppDelegate resumeCommandForSession:session yoloEnabled:self.yoloEnabled];
    [self launchTerminalCommand:command];
}

- (void)launchTerminalCommand:(NSString *)command {
    NSString *script = [NSString stringWithFormat:
        @"tell application \"Terminal\"\nactivate\ndo script \"%@\"\nend tell",
        CPAppleScriptString(command)];
    [self launchTool:@"/usr/bin/osascript" arguments:@[@"-e", script]];
}

- (void)copyResumeCommandForSession:(NSDictionary *)session {
    NSString *command = [AppDelegate resumeCommandForSession:session yoloEnabled:self.yoloEnabled];
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:command forType:NSPasteboardTypeString];
}

+ (NSString *)resumeCommandForSession:(NSDictionary *)session yoloEnabled:(BOOL)yoloEnabled {
    NSString *modeFlag = yoloEnabled ? @" --dangerously-bypass-approvals-and-sandbox" : @"";
    return [NSString stringWithFormat:@"cd %@ && codex resume%@ %@",
            CPShellQuote(session[@"cwd"] ?: @""),
            modeFlag,
            CPShellQuote(session[@"id"] ?: @"")];
}

+ (NSString *)remoteResumeCommandForSession:(NSDictionary *)session yoloEnabled:(BOOL)yoloEnabled {
    NSString *modeFlag = yoloEnabled ? @" --dangerously-bypass-approvals-and-sandbox" : @"";
    NSString *remoteCommand = [NSString stringWithFormat:@"cd %@ && codex resume%@ %@",
                               CPShellQuote(session[@"cwd"] ?: @""),
                               modeFlag,
                               CPShellQuote(session[@"remoteSessionId"] ?: @"")];
    return [NSString stringWithFormat:@"ssh -t %@ %@",
            CPShellQuote(session[@"remoteHost"] ?: @""),
            CPShellQuote(remoteCommand)];
}

- (void)launchTool:(NSString *)path arguments:(NSArray<NSString *> *)arguments {
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:path];
    task.arguments = arguments;
    task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    [task launchAndReturnError:nil];
}

- (void)togglePanel:(id)sender {
    if (self.panel.visible) {
        [self.panel orderOut:nil];
    } else {
        [self.panel orderFrontRegardless];
        [self refreshSessions];
    }
}

static NSString *CPShellQuote(NSString *value) {
    return [NSString stringWithFormat:@"'%@'", [value stringByReplacingOccurrencesOfString:@"'"
                                                                         withString:@"'\\''"]];
}

static NSString *CPAppleScriptString(NSString *value) {
    return [[value stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"]
                   stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
}

@end
