package com.love.todo;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // super 内部完成 setTheme(NoActionBar) + setContentView(WebView 布局) + 插件加载
        // 返回后 window 已绑定到 NoActionBar 主题，此时配置系统栏不会被后续 setTheme 重置
        super.onCreate(savedInstanceState);

        // 让 WebView 内容延伸到状态栏后面（Android 15+ 已强制 edge-to-edge，此处显式调用兼容 Android 7-14）
        // 配合前端 viewport-fit=cover + env(safe-area-inset-top) 让顶栏 padding 自动避开状态栏
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // 状态栏图标深色（顶栏底色浅 rose，深色图标对比清晰；导航栏同理）
        // SystemBars 插件默认 STYLE_DEFAULT 在夜间模式会切到白色图标导致不可见，此处强制深色兜底
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);

        // decor view 背景 rose 色（WebView 加载完成前的 100-300ms 间隙可见，避免白条）
        // SystemBars 在 load() 后会用 windowBackground 重新覆盖，所以 styles.xml 必须把
        // AppTheme.NoActionBar 的 android:windowBackground 也设为同色（见 styles.xml 改动）
        getWindow().getDecorView().setBackgroundColor(android.graphics.Color.parseColor("#FFE4E6"));
    }
}
