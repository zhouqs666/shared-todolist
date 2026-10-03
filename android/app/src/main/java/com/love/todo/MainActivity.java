package com.love.todo;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.love.todo.plugins.ApkInstallerPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App 内 APK 更新插件必须在 super.onCreate() 之前注册——
        // BridgeActivity 在 super 内部会初始化插件注册表，之后再调 registerPlugin 就晚了。
        registerPlugin(ApkInstallerPlugin.class);

        // super 内部完成 setTheme(NoActionBar) + setContentView(WebView 布局) + 插件加载
        // 返回后 window 已绑定到 NoActionBar 主题，此时配置系统栏不会被后续 setTheme 重置
        super.onCreate(savedInstanceState);

        // 让 WebView 内容延伸到状态栏后面（Android 15+ 已强制 edge-to-edge，此处显式调用兼容 Android 7-14）
        // 配合前端 viewport-fit=cover + env(safe-area-inset-top) 让顶栏 padding 自动避开状态栏
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // 状态栏图标深色（顶栏底色浅 rose，深色图标对比清晰；导航栏同理）
        // 系统默认外观跟随夜间模式，会切到白色图标导致在浅色顶栏上不可见，此处强制深色图标兜底
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);

        // decor view 背景 rose 色（WebView 加载完成前的 100-300ms 间隙可见，避免白条）
        // WebView 布局使用主题的 windowBackground，加载后会覆盖此处设置的 decor 背景，
        // 所以 styles.xml 必须把 AppTheme.NoActionBar 的 android:windowBackground 也设为同色（见 styles.xml）
        getWindow().getDecorView().setBackgroundColor(android.graphics.Color.parseColor("#FFE4E6"));
    }
}
