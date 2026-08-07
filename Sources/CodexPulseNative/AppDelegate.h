#import <Cocoa/Cocoa.h>

@interface AppDelegate : NSObject <NSApplicationDelegate>

+ (NSString *)resumeCommandForSession:(NSDictionary *)session yoloEnabled:(BOOL)yoloEnabled;
+ (NSString *)remoteResumeCommandForSession:(NSDictionary *)session yoloEnabled:(BOOL)yoloEnabled;
+ (NSArray<NSDictionary *> *)sessionsByApplyingCompletionTracking:(NSArray<NSDictionary *> *)sessions
                                                 trackingStartedAt:(NSTimeInterval)trackingStartedAt
                                           acknowledgedCompletions:(NSSet<NSString *> *)acknowledgedCompletions;

@end
