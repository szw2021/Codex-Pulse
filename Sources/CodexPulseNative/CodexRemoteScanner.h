#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface CodexRemoteScanner : NSObject

- (NSArray<NSDictionary *> *)scanHost:(NSString *)host
                                 error:(NSError * _Nullable * _Nullable)error;
+ (BOOL)isValidHost:(NSString *)host;
+ (NSArray<NSString *> *)discoverSSHHosts;
+ (NSArray<NSString *> *)hostsFromSSHConfigAtURL:(NSURL *)configURL;
+ (NSArray<NSDictionary *> *)sessionsFromJSONData:(NSData *)data
                                               host:(NSString *)host
                                              error:(NSError * _Nullable * _Nullable)error;

@end

NS_ASSUME_NONNULL_END
