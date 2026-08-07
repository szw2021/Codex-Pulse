#import <Cocoa/Cocoa.h>
#import "AppDelegate.h"

static AppDelegate *applicationDelegate;

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        applicationDelegate = [[AppDelegate alloc] init];
        application.delegate = applicationDelegate;
        [application run];
    }
    return 0;
}
