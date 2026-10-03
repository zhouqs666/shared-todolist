# 本机模拟器黑屏排障手册（Medium_Phone_API_36.1）

> AGENTS.md 只保留每次启动要用的内核（启动命令、就绪判据、两条已修复根因的一句话提醒）。
> 完整取证流程在这里。2026-10-02 凌晨连续两次启动失败（进程活着、窗口黑屏、`adb` 永远 `offline`），
> 当晚定位为**三类独立根因**，全部修复并验证（冷启动 + 快照回环多轮全绿）。

## 现状

默认命令即可稳定启动，不再需要任何参数：

```bash
emulator -avd Medium_Phone_API_36.1
# 就绪唯一标准：adb shell getprop sys.boot_completed 返回 1
```

## 三类根因与修复（都是 AVD 本机配置，不涉及仓库代码）

1. **GPU 模式**：`hw.gpu.mode=auto` 在本机解析为 `gpu mode host`（gfxstream/宿主 Vulkan，
   AMD Radeon Pro 5300M），宿主 GPU 初始化**间歇性挂死**（同一命令时好时坏 —— 这就是
   「有时能开有时黑屏」的来源）。✅ 修复：`config.ini` 持久化 `hw.gpu.mode=swiftshader_indirect`
   （软渲染，绕开宿主 GPU 驱动；代价是渲染慢一点，测试场景无所谓）。
   判定生效：启动日志出现 `library_mode swiftshader_indirect gpu mode swiftshader_indirect`。
2. **跨版本残留快照**：`snapshots/default_boot` 由别的模拟器版本保存，新版加载报
   `The snapshot requires the feature: 21, which the emulator does not support`（加载失败会回退冷启动，
   但加载挂死时就是黑屏）。✅ 修复：删除残留快照；**模拟器升级后若快照加载报错/挂死，直接删
   `~/.android/avd/<名>.avd/snapshots/default_boot`**（只丢开机内存态，不丢 App 数据）。
   快照回环已验证同版本下可靠（关机存盘 → 下次启动 ~3.5 秒恢复）。
3. **`linggan_droid` 内存解析失败**：config.ini 里 `hw.ramSize = 2048M`（带单位带空格的模板格式）
   模拟器**没解析成功，静默回退 256MB** → Android 16 起不来，zygote OOM →
   `Kernel panic: System is deadlocked on memory` → **无限重启循环**（窗口黑、adb 永远 offline、
   qemu 200% CPU 空转）。✅ 修复：改成纯数字 `hw.ramSize=2048`（与正常 AVD 同格式）。

## 排障手册（下次再遇黑屏，按序取证，不要原地等）

- **判别「真卡死」还是「正常冷启动」**：通知栏出现「Emulator is performing a full startup」= 正常
  （2-5 分钟，崩溃循环后首次启动可能更久）；持续 5 分钟以上 `getprop sys.boot_completed` 仍空 /
  offline = 真卡死，杀掉再查。
- **带内核日志冷启动**：`emulator -avd <名> -no-snapshot -show-kernel > /tmp/emu.log 2>&1`，然后：
  - `grep 'Memory:' /tmp/emu.log` —— guest 实际拿到的内存（<1G 就是 ramSize 解析问题）；
    出现多行 `Linux version` banner = 重启循环；
  - `grep -E 'oom-killer|Kernel panic' /tmp/emu.log` —— 内存耗尽实锤；
  - `grep 'gpu mode' /tmp/emu.log` —— GPU 模式实际解析成了什么。
- **生成配置会说话**：config.ini 写错会被**静默忽略**，真相在启动后生成的
  `~/.android/avd/<名>.avd/hardware-qemu.ini`（2026-10-02 事故：config 写 2048M，生成配置里是 256）。
  改完 config.ini 后用它回读校验，别信「写过了」。
