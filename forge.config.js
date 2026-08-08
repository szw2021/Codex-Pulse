module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'Codex Pulse',
    appBundleId: 'dev.local.codex-pulse',
    appCategoryType: 'public.app-category.developer-tools',
    extendInfo: {
      CFBundleDevelopmentRegion: 'zh_CN',
      CFBundleDisplayName: 'Codex Pulse',
      LSMinimumSystemVersion: '14.0',
      LSUIElement: true,
      NSAppleEventsUsageDescription: '用于在 Terminal 中继续你选择的 Codex 会话。',
    },
    ignore: [
      /^\/(?:\.git|\.codex|\.build|dist|node_modules|out|scripts|test|Tests|Sources|Resources)(?:\/|$)/,
      /^\/error\.log$/,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
};
