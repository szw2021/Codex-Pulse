#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface CodexScanner : NSObject

- (instancetype)initWithCodexHome:(NSURL *)codexHome;
- (NSArray<NSDictionary *> *)scanSessionsWithError:(NSError * _Nullable * _Nullable)error;

+ (NSDictionary *)detectStateInData:(NSData *)data
                       approvalMode:(NSString *)approvalMode
                         processInfo:(nullable NSDictionary *)processInfo
                      fileModifiedAt:(nullable NSDate *)fileModifiedAt
                                 now:(NSDate *)now;

@end

NS_ASSUME_NONNULL_END
