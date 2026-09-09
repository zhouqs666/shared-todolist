import path from 'path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set ANDROID_HOME for Appium UiAutomator2 driver
if (!process.env.ANDROID_HOME) {
  process.env.ANDROID_HOME = path.join(process.env.HOME, 'Library/Android/sdk');
}

// 测试专用 APK：优先找 release（build-test-apk.mjs 产出），fallback 到 debug（CI 产出）。
// 绝不能换成正式包——正式包指向生产库，跑测试即触碰生产数据（铁律一）。
const releasePath = path.resolve(__dirname, '../android/app/build/outputs/apk/release/app-release.apk');
const debugPath = path.resolve(__dirname, '../android/app/build/outputs/apk/debug/app-debug.apk');
const apkPath = existsSync(releasePath) ? releasePath : debugPath;

export const config = {
  runner: 'local',

  hostname: 'localhost',
  port: 4723,
  path: '/',

  specs: ['./tests/**/*.spec.js'],

  maxInstances: 1,

  capabilities: [
    {
      platformName: 'Android',
      'appium:deviceName': 'Medium_Phone_API_36.1',
      'appium:automationName': 'UiAutomator2',
      'appium:app': apkPath,
      // noReset:false = 每次会话开始清应用数据（fastReset），
      // 保证每个用例都从未登录状态起步，登录/待办流程可确定性复现
      'appium:noReset': false,
      // 清数据会回收运行时权限，这里自动重授，避免启动时 POST_NOTIFICATIONS 系统弹窗挡住用例
      'appium:autoGrantPermissions': true,
      'appium:newCommandTimeout': 180,
      'appium:uiautomator2ServerLaunchTimeout': 60000,
      'appium:adbExecTimeout': 60000,
    },
  ],

  logLevel: 'info',

  framework: 'mocha',

  reporters: [
    'spec',
    [
      'allure',
      {
        outputDir: 'allure-results',
        disableWebdriverStepsReporting: false,
        disableWebdriverScreenshotsReporting: false,
      },
    ],
  ],

  mochaOpts: {
    ui: 'bdd',
    // 用例含多次 App 冷启动 + 登录 + 网络写库，给足单用例超时
    timeout: 180000,
  },

  afterTest: async function (test, context, { error, passed }) {
    // 失败自动截图进 Allure（Allure reporter 自动收集）
    if (!passed) {
      await browser.takeScreenshot();
    }
  },
};
