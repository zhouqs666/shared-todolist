package com.love.todo.plugins;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * App 内 APK 更新迷你插件（无 npm 包，JS 侧经 window.Capacitor.Plugins.ApkInstaller 访问）。
 *
 * 能力：
 *   download({url, sha256?}) → 原生线程下载 APK 到 cache/updates/app-update.apk，
 *       下载中通过 "apkDownloadProgress" 事件回报 {progress, loaded, total}（total 未知时 progress=-1），
 *       传了 sha256 则边下边算，不匹配删文件并 reject（防篡改/防坏包）。
 *   canInstallApks() → Android 8+ 是否已获"未知来源安装"授权。
 *   openInstallPermissionSettings() → 跳系统设置页让用户开"允许安装未知应用"。
 *   install({path}) → FileProvider content:// URI + ACTION_VIEW 唤起系统安装器（用户手动点安装）。
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    private static final String UPDATE_DIR = "updates";
    private static final String APK_NAME = "app-update.apk";

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        final String expectedSha256 = call.getString("sha256");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }

        final Context ctx = getContext();
        new Thread(() -> {
            File dir = new File(ctx.getCacheDir(), UPDATE_DIR);
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("cannot create update dir");
                return;
            }
            // 清掉上次残留的安装包，避免磁盘慢慢堆积多个旧 APK
            File[] olds = dir.listFiles();
            if (olds != null) {
                for (File f : olds) f.delete();
            }
            File out = new File(dir, APK_NAME);

            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                int code = conn.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) {
                    call.reject("HTTP " + code);
                    return;
                }
                long total = conn.getContentLength(); // 可能 -1（chunked）
                MessageDigest digest = MessageDigest.getInstance("SHA-256");

                InputStream in = conn.getInputStream();
                OutputStream os = new FileOutputStream(out);
                byte[] buf = new byte[16384];
                long loaded = 0;
                int lastPct = -1;
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    digest.update(buf, 0, n);
                    loaded += n;
                    int pct = total > 0 ? (int) (loaded * 100 / total) : -1;
                    if (pct != lastPct) { // 整数百分比变化才上报，避免刷爆 JS 桥
                        lastPct = pct;
                        JSObject prog = new JSObject();
                        prog.put("progress", pct);
                        prog.put("loaded", loaded);
                        prog.put("total", total);
                        notifyListeners("apkDownloadProgress", prog);
                    }
                }
                os.flush();
                os.close();
                in.close();

                // SHA256 校验：不匹配视为坏包/被篡改，删文件拒绝安装
                if (expectedSha256 != null && !expectedSha256.isEmpty()) {
                    StringBuilder sb = new StringBuilder();
                    for (byte b : digest.digest()) sb.append(String.format("%02x", b));
                    if (!sb.toString().equalsIgnoreCase(expectedSha256)) {
                        //noinspection ResultOfMethodCallIgnored
                        out.delete();
                        call.reject("sha256 mismatch");
                        return;
                    }
                }

                JSObject ret = new JSObject();
                ret.put("path", out.getAbsolutePath());
                ret.put("size", out.length());
                call.resolve(ret);
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                out.delete();
                call.reject("download failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void canInstallApks(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ret.put("allowed", getContext().getPackageManager().canRequestPackageInstalls());
        } else {
            ret.put("allowed", true); // 8.0 以下声明权限即可，无需单独授权
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("activity unavailable");
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent i = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivity(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "open settings failed");
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path required");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("activity unavailable");
            return;
        }
        File apk = new File(path);
        if (!apk.exists()) {
            call.reject("apk file not found");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                    activity, activity.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "install failed");
        }
    }
}
