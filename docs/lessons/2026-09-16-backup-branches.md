# 2026-09-16：12 个本地 backup/* 分支，「备份」只活在硬盘上

**关联规则**：AGENTS.md 铁律三（回滚锚点用 tag）

## 发生了什么

清点本机分支时发现堆了 12 个 `backup/pre-*` 分支，**一个都没推到远端**：

- 其中 11 个的内容早已在 main 历史里（删了无损）；
- 但 `backup/v2.7.57-history-page` **是那份功能代码的唯一副本**（main 里查不到该功能）——
  名字叫 backup，却只活在本机硬盘上。换机 / 丢盘时，这种「备份」等于零。

## 关键认知

- 本地分支不是备份。tag 不可变、可随仓库走、别人也拿得到。
- 实测验证：用 `git tag -a anchor/v2.7.57-history-page` 并 push 后，
  `release.mjs 2.7.68 --from-git <tag> --dry-run` 全流程通过（annotated tag 也能直接用 ——
  `git rev-parse --verify <ref>^{commit}` 会解析）。

## 规则（落地在 AGENTS.md 铁律三）

- 回滚锚点：`git tag -a anchor/<版本或日期>-<主题> <sha>` **并 `git push origin <tag>`**，
  正文写清「为什么留」
- `--from-git` 收的是任意 git ref，annotated tag 直接可用
