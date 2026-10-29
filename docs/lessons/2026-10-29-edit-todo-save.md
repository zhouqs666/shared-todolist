# 2026-10-29 · 编辑待办「无法保存」：删了一个函数，忘了还有调用点

> 一句话：**F-04 重构删掉了旧「完成备注」面板和它的 `closeNotePanel()`，同一文件里的「编辑待办」面板仍在调用它** →
> 点「保存」抛 `ReferenceError`，且**抛在 `try` 之外** → `db.updateTodoText()` 根本没执行 →
> 而页面因为乐观更新仍显示新文案 → 刷新即回退 → 线上 3.7.2 带着这个 bug 跑了 6 天。

- 发现时间：2026-10-29（用户报「编辑待办功能无法保存」）
- 影响版本：3.7.1 起（2026-10-09 引入）→ 3.7.2（2026-10-23 发布，仍带 bug）
- 影响范围：所有用户、所有平台（Web / APK 均命中同一份 `public/js/app.js`）
- 关联规则：铁律二（测试覆盖）、铁律四（文档同步）、铁律六（代码审查）

---

## 1. 发生了什么

用户报：「编辑待办功能无法保存」。

复现（测试库，Playwright）：

```
== 4. 改文案并点保存 ==
   面板仍在 DOM: True          ← 面板没关
   toast 文本: ''              ← 既没有「已保存」，也没有「保存失败」
   列表里 新文案=1 旧文案=0    ← 看起来"改了"！
== 5. 刷新页面看是否真的落库 ==
   刷新后 新文案=0 旧文案=1    ← 回到原样
===== 页面错误 =====
  [pageerror] closeNotePanel is not defined
```

三个细节合起来构成本次事故最迷惑的地方：**看起来保存了，其实没有；没有任何报错提示。**

## 2. 根因

### 2.1 直接原因：调用点残留

`public/js/app.js` 里 `closeNotePanel()` 被**调用 3 次**，但**全项目没有任何定义**：

| 位置 | 调用场景 |
|---|---|
| `app.js` `openEditPanel()` | 点遮罩关闭面板 |
| `app.js` `openEditPanel()` | ESC 关闭面板 |
| `app.js` `saveEditText()` | 保存成功后关闭面板 |

引入时间：2026-10-09 的 `7602f7c`（feat(留言): 完成备注升级为双人留言板 + 回复（F-04））。
那次重构把旧「完成备注」面板整体搬到 `comments.js`，**连同它共用的 `closeNotePanel()` 一起从 `app.js` 删掉了** ——
但「编辑待办」面板也复用了同一个 `closeNotePanel()`，重构时**只删了定义、没删调用点**。

```
7602f7c 删除：  -function openNotePanel(todo) { ... }
                -function closeNotePanel() { ... }
                -async function saveNote(id, text) { ... }
7602f7c 保留：   function openEditPanel(todo) { ... closeNotePanel() ... }   ← 调用点活了下来
```

### 2.2 放大原因：抛出点在 `try` 之外

```js
async function saveEditText(id, text) {
  ...
  current.text = text;
  setTodos(getTodos());      // ① 乐观更新：列表已经显示新文案
  closeNotePanel();          // ② ❌ 在 try 之外 —— 这里抛 ReferenceError
  try {
    await db.updateTodoText(id, text);   // ③ 永远到不了
    showToast('已保存');
  } catch (err) { ... }      // ④ 永远进不了
}
```

三个后果叠加：

1. **DB 没写**（③ 未执行）—— 数据没落库；
2. **没有错误提示**（④ 未执行）—— 用户看不到任何报错，只看到「点了没反应」；
3. **UI 显示新文案**（① 已执行）—— 眼睛看到"改了"，于是最初的排查方向完全跑偏
   （第一反应是「数据库写失败」「RLS 拦截」「CHECK 约束」）。

第 3 点是本事故最大的误导来源：**乐观更新把「UI 正常」和「数据落库」这两件事解耦了**，
而绝大多数「保存类」bug 的表面症状恰好就是"UI 看起来变了"。

### 2.3 制度原因：核心功能零测试覆盖

在 bug 存在的那 6 天里，`app-e2e/` 与 `scripts/test_*.py` 里**没有任何一条用例涉及「编辑待办」**：

```bash
grep -rn "编辑待办\|note-input-panel\|saveEditText" app-e2e/ --include="*.py" --include="*.js"
# （无输出）
```

「编辑待办文案」是双人共享应用的核心功能之一，上线至今**一次都没有被自动化测过**。
没有测试的功能 = 没有护栏的功能 = 重构时靠人眼记忆兜底 —— 而人眼在几千行里
看不出「这个函数名从没被定义过」。

## 3. 修复与防回归

### 3.1 修复（`public/js/app.js`）

1. **恢复 `closeNotePanel()` 定义**；
2. **给编辑面板的 overlay 加专属类 `.edit-panel-overlay`** —— 提醒面板也用 `.note-input-overlay`，
   用专属类避免「关编辑面板时误关提醒面板」的串台；
3. **ESC 监听器由 `closeNotePanel()` 统一摘除**（旧实现只在「自己触发 ESC」时摘，
   点保存/点遮罩关闭后监听器会残留到下次按键）；
4. **`saveEditText()` 里关面板单独兜异常**：

   ```js
   // 关面板是**表现层**，绝不能让它挡住落库
   try { closeNotePanel(); } catch (e) { console.error('[app] 关闭编辑面板失败（不阻塞保存）', e); }
   ```

   这一条是把「表现层异常 → 吞掉数据层动作」的耦合彻底拆开：
   以后就算再出现未定义引用，保存也一定会执行，失败时至少有 toast 可看。

### 3.2 防回归三道闸

| 闸 | 位置 | 作用 |
|---|---|---|
| 静态守卫 | `scripts/check-undefined-refs.mjs`（进 `ci.yml`） | 机器判定「引用了不存在的东西」，秒级、零漏报 |
| 端到端用例 | `scripts/test_edit_todo.py`（进 `run-web-e2e.mjs` / `e2e-web-full.yml`） | 钉住「保存真的落库」 |
| 审查清单 | `CODE-REVIEW.md` 维度 D/F | 提醒 reviewer 看「删定义时有没有留调用点」 |

**静态守卫**（新增）查两类问题：

- **A. 未定义引用** —— 剥掉注释/字符串/模板/正则字面量，收集所有声明名
  （function/class/const/let/var/import/形参/对象方法/导出/全局赋值），
  再收集所有调用点（标识符后紧跟 `(`，且前面不是 `.`），差集即报错；
- **B. 模块链接错误** —— 按相对路径解析 `./x.js`，比对「import 的名字」与
  「目标模块的导出集」。守的是同一个 bug 类的另一半：**删了导出却忘了删引用它的 import**
  —— 那种错更致命，模块加载就报错，整页功能一起挂。

两项都实测过**真的会红**：

```bash
$ git stash push -- public/js/app.js && node scripts/check-undefined-refs.mjs
✗ 发现 1 处「被调用但全项目未定义」的引用：
   app.js  →  closeNotePanel()
exit=1
$ git stash pop && node scripts/check-undefined-refs.mjs
✅ 未定义引用检查通过（38 个模块，0 处「被调用但未定义」）
✅ 模块链接检查通过（0 处「import 了不存在的东西」）
exit=0
```

（模拟「删掉 `toSticker` 的 export 但保留两处 import」时，B 检查精确报出 `db.js` 与
`realtime.js` 两行。）

**端到端用例**的核心断言是「**刷新页面后新文案仍在**」而不是「列表变了」：

```python
page.reload(wait_until="domcontentloaded")
check("刷新后新文案仍在（已落库）", page.locator(".todo", has_text=NEW_TEXT).count() >= 1)
```

因为乐观更新会让「列表变了」这条断言在 bug 版本下**照样通过**（见 §2.2 第 3 点）——
只有刷新后回读才能区分「本地改了」与「落库了」。

同样验证过它**在 bug 版本会红**（6 失败 / 6 通过，含 `[pageerror] closeNotePanel is not defined`），
在修复版本**全绿**（14/14）。

## 4. 教训

1. **「删定义」与「删调用点」必须同一次提交完成。**
   重构时最容易漏的就是这类「看似只属于被删模块、其实被别人共用」的辅助函数。
   review 时要专门问一句：*这个函数还有别的调用点吗？*

2. **表现层的异常绝不能挡住数据层的动作。**
   `closeNotePanel()` 是纯 UI 收尾，它的失败不该让「写数据库」这个正事消失。
   凡是「先做 A（表现）再做 B（数据）」的顺序，B 必须在 A 的异常之外。

3. **乐观更新会伪装成"保存成功"。**
   任何「保存类」功能的自动化断言，都必须**回读数据源**（刷新/重查），
   断言「界面上变了」等于没断言。

4. **「零报错」不等于「成功」。**
   这次 bug 的表面症状恰恰是**没有任何报错**（catch 块根本没进）。
   因此 E2E 不能只断言「没抛异常」，要断言「结果对」。

5. **没有测试的功能，重构时等于没有护栏。**
   本次能上线 6 天，直接原因就是「编辑待办」从来没有过一条测试。
   新增功能时同步补一条 E2E，比事后补便宜得多。

6. **静态判定 > 人眼判定。**
   「这个函数名从没被定义过」这种事，人眼要通读全文才敢下结论，机器是秒级且零漏报的。
   这与本项目已有的三个守卫（只读守卫 / 凭据键三方一致 / actions SHA 固定）是同一条思路：
   **把"靠自觉"变成"漏挂直接红"**。

## 5. 关联

- `AGENTS.md` 铁律二（交付前必须全面测试）、铁律六（提交前必须走代码审查）
- `CODE-REVIEW.md` 维度 B（订阅/删除的连带影响）、维度 C（重构时的连带删除）
- `scripts/check-undefined-refs.mjs`（新增守卫）
- `scripts/test_edit_todo.py`（新增用例）
- `docs/lessons/2026-10-09-partial-table-subscription.md`（同期的另一例「重构漏掉连带影响」）
