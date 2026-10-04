/**
 * 第二册「我们的故事」内容模块（图鉴路线批次 3 · docs/sticker-book-roadmap.md §6）
 *
 * 纯数据模块（零 import，被 blindbox.js 的 SERIES_DEFS 注册表引用）。
 *
 * ⚠️ 隐私红线（路线图 §6.3，提交前人工通读）：本文件允许入库的只有
 * 抽象化短句 + 两字贴纸名 + SVG——**陌生人看不出任何具体事实**
 * （不得含可识别的地名 / 店名 / 人名 / 日期 / 昵称）。十二题的原始回答
 * 只存在于业主仓库外材料中，不进本仓库；注释里也只允许出现路线图 D11
 * 已锁定的题号与抽象主题（如 Q11「小心地滑」——公共标识语，无识别信息）。
 *
 * 稀有度分配（D11，2026-10-04 业主锁定）：
 *   传说 ×4 = Q4 宝宝 · Q2 「像」 · Q10 平常的一天 · Q12 收尾句
 *   史诗 ×4 = Q1 初见 · Q6 深夜不睡 · Q7 和好 · Q11 「小心地滑」
 *   稀有 ×4 = Q3 便当 · Q5 整座城 · Q8 「衣服撑」 · Q9 外号梗
 * 其中 Q9 外号梗按 D3 红线默认抽象（昵称不入库）→ 定名「暗号」，
 * 意象为两只对碰的对话气泡；业主若确认保留原名，只需改本文件的名称与短句。
 *
 * 叙事顺序说明（§6.2）：十二题的叙事弧线藏在每张贴纸的故事卡短句里，
 * 不在网格顺序上强求——网格仍按稀有度分区，序号顺序即 D11 表内顺序。
 *
 * SVG 语言与第一册一致（手作底线）：48×48 viewBox、单文件内联、
 * 渐变 id 全局唯一（story1a…story12b——同一文档会同时渲染多份 SVG）、
 * 白色高光 + 星芒点缀；同稀有度共用档位配色，格子的稀有度底色由 CSS 承担。
 */

/** 册书脊 / 封面专属配色（D5 便宜版）：夜蓝 + 暖黄窗光，呼应「深夜亮着灯的窗」意象；
 *  第一册保持樱粉默认（零变化），册间用 tab 书脊色区分 */
export const STORY_ACCENT = {
  spine: '#5b7fa6',
  tint: 'rgba(91, 127, 166, 0.14)',
  ink: '#47698e',
};

export const STORY_META = {
  rare: {
    stickerNames: ['便当', '满城', '衣撑', '暗号'],
    stickerFlavors: [
      '装的不只是饭，是怕它凉掉的用心',
      '常去的地方写不下，干脆写了整座城',
      '你那些老派的词，说出来像一首小诗',
      '有些称呼只在我们之间流通，甜度不外传',
    ],
    // 便当·饭盒：木色盒身 + 樱粉布巾结 + 两缕热气
    stickerIcons: [
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story1a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3d3ae"/><stop offset="1" stop-color="#cf9668"/></linearGradient></defs><path d="M16.5 7.5c-2 2.4-2 4.6 0 7" stroke="#f3b9cd" stroke-width="2.2" stroke-linecap="round" fill="none" opacity=".8"/><path d="M24.5 5.5c-2 2.4-2 4.6 0 7" stroke="#f3b9cd" stroke-width="2.2" stroke-linecap="round" fill="none" opacity=".55"/><path d="M24 17.5 17 13.3v8.4z" fill="#f9a8c4"/><path d="M24 17.5l7-4.2v8.4z" fill="#f06fa0"/><circle cx="24" cy="17.5" r="2.7" fill="#e2548c"/><rect x="9" y="20" width="30" height="21" rx="5" fill="url(#story1a)"/><rect x="9" y="20" width="30" height="6.5" rx="3.2" fill="#a86f45" opacity=".45"/><path d="M24 30v9.5M13 34.5h22" stroke="#a86f45" stroke-width="1.6" opacity=".4" stroke-linecap="round"/><circle cx="18.5" cy="32.2" r="1.5" fill="#fff" opacity=".6"/><ellipse cx="13.5" cy="23.5" rx="1.5" ry="2.4" fill="#fff" opacity=".5"/></svg>',
      // 满城·地图：摊开的三折地图 + 粉色虚线路线 + 两枚重叠脚印位（两枚地图钉）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story2a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dbeafe"/><stop offset="1" stop-color="#bfd7f8"/></linearGradient></defs><path d="M7 13.5l8.5-3 8.5 3 8.5-3 8.5 3v19l-8.5 3-8.5-3-8.5 3-8.5-3z" fill="url(#story2a)"/><path d="M15.5 10.7v21.6M32.5 10.7v21.6" stroke="#93c5fd" stroke-width="1.4" opacity=".6"/><path d="M12 28c4-6 7.5 2 11.5-4s8 .5 12-5" stroke="#f472a0" stroke-width="2" stroke-dasharray="3.2 3.2" stroke-linecap="round" fill="none"/><path d="M13.5 20.5a3 3 0 0 1 6 0c0 2.2-3 4.6-3 4.6s-3-2.4-3-4.6z" fill="#e2548c"/><circle cx="16.5" cy="20.4" r="1.1" fill="#fff"/><path d="M30 18.5a2.4 2.4 0 0 1 4.8 0c0 1.8-2.4 3.7-2.4 3.7s-2.4-1.9-2.4-3.7z" fill="#f9a8c4"/><circle cx="32.4" cy="18.4" r=".9" fill="#fff"/><path d="M0-2.7Q.7-.7 2.7 0 .7.7 0 2.7-.7.7-2.7 0-.7-.7 0-2.7Z" fill="#fda4af" opacity=".9" transform="translate(41 7)"/></svg>',
      // 衣撑·衣架：木质衣架（挂钩 + 三角肩 + 横杆）+ 粉色对话气泡（白色小心）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story3a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e0b184"/><stop offset="1" stop-color="#c08653"/></linearGradient></defs><path d="M24 14.5c0-2.2-1.5-3.2-3.2-3.2a3.2 3.2 0 1 1 3.2-3.2" stroke="#a86f45" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M24 14.8c-.5 2.2-1.9 3.2-4.6 4.2l-9.8 4.4c-2.5 1.1-2.1 4.7 1.2 4.7h26.4c3.3 0 3.7-3.6 1.2-4.7l-9.8-4.4c-2.7-1-4.1-2-4.6-4.2z" fill="url(#story3a)"/><rect x="10.5" y="31.5" width="27" height="2.6" rx="1.3" fill="#c08653"/><ellipse cx="15" cy="20.5" rx="1.4" ry="2.2" fill="#fff" opacity=".4" transform="rotate(-24 15 20.5)"/><rect x="28.5" y="3.5" width="16" height="11" rx="4.5" fill="#f9a8c4"/><path d="M32 14l-2.5 4 6-2.2z" fill="#f9a8c4"/><path d="M36.5 6.6c.8-1.3 2.8-1.1 3.3.3.5-1.4 2.5-1.6 3.3-.3.6 1.1-.4 2.4-3.3 4.4-2.9-2-3.9-3.3-3.3-4.4z" fill="#fff" opacity=".95"/></svg>',
      // 暗号·对碰气泡：粉白两只气泡相碰 + 心与星（外号梗的抽象化，见文件头注释）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story4a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbcfe8"/><stop offset="1" stop-color="#f472a0"/></linearGradient></defs><rect x="5.5" y="9" width="25" height="17.5" rx="7.5" fill="url(#story4a)"/><path d="M13.5 26l-2.2 6.5 7.5-4.6z" fill="#f472a0"/><path d="M14.5 14.5c1-1.6 3.4-1.4 4 .4.6-1.8 3-2 4-.4.8 1.5-.5 3.2-4 5.6-3.5-2.4-4.8-4.1-4-5.6z" fill="#fff" opacity=".95"/><rect x="27.5" y="20" width="15.5" height="12" rx="5.5" fill="#fff7ed" stroke="#f3b9cd" stroke-width="1.4"/><path d="M35.5 31.5l4.5 2.6-1.6-3.4z" fill="#fff7ed" stroke="#f3b9cd" stroke-width="1.4" stroke-linejoin="round"/><path d="M33.5 24l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" fill="#f59e0b"/><path d="M0-2.7Q.7-.7 2.7 0 .7.7 0 2.7-.7.7-2.7 0-.7-.7 0-2.7Z" fill="#fda4af" transform="translate(41.5 12)"/><path d="M0-2.2Q.6-.6 2.2 0 .6.6 0 2.2-.6.6-2.2 0-.6-.6 0-2.2Z" fill="#f9a8d4" opacity=".8" transform="translate(6 34)"/></svg>',
    ],
  },
  epic: {
    stickerNames: ['初遇', '深夜', '和好', '小心'],
    stickerFlavors: [
      '第一句闲聊，比货架上的什么都先被记住',
      '吵着吵着，谁也不肯先说晚安',
      '最凶的一次，和好也最快',
      '一句「小心地滑」，成了泥泞里最好笑的认真',
    ],
    // 初遇·购物袋：并排两只提袋（紫 + 粉）+ 星芒（第一次见面的场合意象，抽象为"并排的两只袋子"）
    stickerIcons: [
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story5a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient><linearGradient id="story5b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f9a8d4"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><ellipse cx="24" cy="42" rx="15" ry="2.4" fill="#8b5cf6" opacity=".18"/><path d="M12.5 16.5v-2.8a3.2 3.2 0 0 1 6.4 0v2.8" stroke="#8b5cf6" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M9.5 16.5h12.4l-1.4 20.2c-.1 1.5-1.4 2.8-3 2.8h-3.6c-1.6 0-2.9-1.3-3-2.8z" fill="url(#story5a)"/><path d="M30.5 20v-2.6a3 3 0 0 1 6 0V20" stroke="#ec4899" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M27.8 20h11.4l-1.3 17.4c-.1 1.4-1.3 2.6-2.8 2.6h-3.2c-1.5 0-2.7-1.2-2.8-2.6z" fill="url(#story5b)"/><ellipse cx="13.5" cy="20.5" rx="1.3" ry="2.2" fill="#fff" opacity=".45" transform="rotate(-8 13.5 20.5)"/><ellipse cx="31.5" cy="23.5" rx="1.2" ry="2" fill="#fff" opacity=".45" transform="rotate(-8 31.5 23.5)"/><path d="M0-3Q.8-.8 3 0 .8.8 0 3-.8.8-3 0-.8-.8 0-3Z" fill="#c4b5fd" transform="translate(39 8)"/><path d="M0-2.4Q.65-.65 2.4 0 .65.65 0 2.4-.65.65-2.4 0-.65-.65 0-2.4Z" fill="#f9a8d4" opacity=".85" transform="translate(7.5 8.5)"/></svg>',
      // 深夜·窗：夜色窗框 + 两亮两暗的窗格 + 暖光 + 弯月与星（谁也不肯先睡的那扇窗）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story6a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c5a94"/><stop offset="1" stop-color="#2e3a68"/></linearGradient><linearGradient id="story6b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset="1" stop-color="#fcd34d"/></linearGradient></defs><rect x="11" y="6.5" width="26" height="34" rx="3" fill="url(#story6a)"/><rect x="14" y="9.5" width="9" height="12.5" rx="1.5" fill="url(#story6b)"/><rect x="25" y="9.5" width="9" height="12.5" rx="1.5" fill="#243055"/><rect x="14" y="24.5" width="9" height="13" rx="1.5" fill="#243055"/><rect x="25" y="24.5" width="9" height="13" rx="1.5" fill="url(#story6b)"/><path d="M24 6.5v34M11 23.5h26" stroke="#2e3a68" stroke-width="2.2"/><rect x="9" y="40.5" width="30" height="3.2" rx="1.6" fill="#2e3a68"/><path d="M31.5 13.5a3.4 3.4 0 1 1-3-5 2.7 2.7 0 1 0 3 5z" fill="#fde68a"/><path d="M17 28.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" fill="#fde68a" opacity=".8"/><ellipse cx="16.2" cy="12" rx="1.2" ry="2" fill="#fff" opacity=".5"/></svg>',
      // 和好·碰杯：两只倾身相碰的杯子 + 杯口星芒 + 小心心（和好瞬间）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story7a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient><linearGradient id="story7b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f9a8d4"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><g transform="rotate(-14 16 28)"><rect x="10" y="19" width="12.5" height="17" rx="4.2" fill="url(#story7a)"/><rect x="10" y="19" width="12.5" height="5" rx="2.5" fill="#fff" opacity=".35"/><ellipse cx="13" cy="23" rx="1.2" ry="2" fill="#fff" opacity=".5"/></g><g transform="rotate(14 32 28)"><rect x="25.5" y="19" width="12.5" height="17" rx="4.2" fill="url(#story7b)"/><rect x="25.5" y="19" width="12.5" height="5" rx="2.5" fill="#fff" opacity=".35"/><ellipse cx="28.5" cy="23" rx="1.2" ry="2" fill="#fff" opacity=".5"/></g><path d="M24 6.5l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" fill="#fde68a"/><path d="M24 15.5c.9-1.5 3.2-1.3 3.8.4.6-1.7 2.9-1.9 3.8-.4.7 1.4-.5 3-3.8 5.2-3.3-2.2-4.5-3.8-3.8-5.2z" fill="#f9a8d4" opacity=".9"/><ellipse cx="24" cy="41.5" rx="12" ry="2" fill="#8b5cf6" opacity=".16"/></svg>',
      // 小心·警示牌：微倾的黄色菱形牌 + 两道水波纹 + 紫色星芒（「小心地滑」的路牌意象）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story8a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f0b429"/></linearGradient></defs><g transform="rotate(-8 24 25)"><rect x="13" y="14" width="22" height="22" rx="4" transform="rotate(45 24 25)" fill="url(#story8a)" stroke="#d97706" stroke-width="1.6"/><path d="M18 23.5c1.7-1.9 3.4-1.9 5.1 0s3.4 1.9 5.1 0" stroke="#fff" stroke-width="2.1" stroke-linecap="round" fill="none"/><path d="M19.5 28.5c1.5-1.7 3-1.7 4.5 0s3 1.7 4.5 0" stroke="#fff" stroke-width="2.1" stroke-linecap="round" fill="none" opacity=".85"/></g><path d="M0-2.7Q.7-.7 2.7 0 .7.7 0 2.7-.7.7-2.7 0-.7-.7 0-2.7Z" fill="#a78bfa" transform="translate(40.5 10)"/><path d="M0-2.2Q.6-.6 2.2 0 .6.6 0 2.2-.6.6-2.2 0-.6-.6 0-2.2Z" fill="#c4b5fd" opacity=".85" transform="translate(6.5 36.5)"/><path d="M8 12c1.4 1.6 3 2.4 5 2.4" stroke="#d97706" stroke-width="1.8" stroke-linecap="round" fill="none" opacity=".5"/><path d="M40 38c-1.4 1.6-3 2.4-5 2.4" stroke="#d97706" stroke-width="1.8" stroke-linecap="round" fill="none" opacity=".5"/></svg>',
    ],
  },
  legendary: {
    stickerNames: ['宝宝', '双生', '平常', '一直'],
    stickerFlavors: [
      '小小的人一来，整个世界都变软了',
      '「你们好像啊」——这句话是别人先发现的',
      '最想回去的，是没有标题的普通一天',
      '想对一年后的你说：一直有爱下去',
    ],
    // 宝宝·摇篮：金色摇篮 + 粉色小被 + 头顶悬星（全册最软的一张）
    stickerIcons: [
      // 宝宝·小袜子：金色小袜（粉色袜口 + 白色小心）+ 星芒（全册最软的一张）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story9a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f0b429"/></linearGradient></defs><path d="M16 13.5H27.5V23.5C27.5 25 28 26.4 29 27.4L32.5 30.8C35.5 33.7 33.4 38.7 29.3 38.7C27.7 38.7 26.2 38.1 25 36.9L17.9 29.8C16.7 28.6 16 27 16 25.2Z" fill="url(#story9a)"/><rect x="14.5" y="10.5" width="14.5" height="6.5" rx="3.2" fill="#f9a8d4"/><path d="M19.5 18.6c.7-1.2 2.6-1 3.1.3.5-1.3 2.4-1.5 3.1-.3.6 1-.4 2.2-3.1 4-2.7-1.8-3.7-3-3.1-4z" fill="#fff" opacity=".92"/><ellipse cx="18.6" cy="16.8" rx="1.1" ry="1.9" fill="#fff" opacity=".55"/><path d="M0-2.7Q.7-.7 2.7 0 .7.7 0 2.7-.7.7-2.7 0-.7-.7 0-2.7Z" fill="#fbbf24" transform="translate(39.5 12)"/><path d="M0-2.1Q.6-.6 2.1 0 .6.6 0 2.1-.6.6-2.1 0-.6-.6 0-2.1Z" fill="#fde68a" opacity=".9" transform="translate(8.5 30)"/><path d="M0-1.7Q.5-.5 1.7 0 .5.5 0 1.7-.5.5-1.7 0-.5-.5 0-1.7Z" fill="#f9a8d4" opacity=".85" transform="translate(37 30.5)"/></svg>',
      // 双生·并蒂树：两棵小树树冠相触 + 触点一颗心 + 金色星芒（「像」是别人先发现的）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story10a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset="1" stop-color="#f0b429"/></linearGradient></defs><path d="M10.5 41.5h27" stroke="#d97706" stroke-width="2" stroke-linecap="round" opacity=".45"/><path d="M17.5 40c-.6-5.2-.6-9.6 0-14" stroke="#b45309" stroke-width="2.6" stroke-linecap="round" fill="none"/><path d="M30.5 40c.6-5.2.6-9.6 0-14" stroke="#b45309" stroke-width="2.6" stroke-linecap="round" fill="none"/><circle cx="16.5" cy="18.5" r="8" fill="url(#story10a)"/><circle cx="31.5" cy="18.5" r="8" fill="url(#story10a)"/><circle cx="16.5" cy="18.5" r="8" fill="#f59e0b" opacity=".18"/><circle cx="31.5" cy="18.5" r="8" fill="#f59e0b" opacity=".18"/><path d="M20.5 16.2c.9-1.5 3.2-1.3 3.8.4.6-1.7 2.9-1.9 3.8-.4.7 1.4-.5 3-3.8 5.2-3.3-2.2-4.5-3.8-3.8-5.2z" fill="#fff"/><path d="M0-2.4Q.65-.65 2.4 0 .65.65 0 2.4-.65.65-2.4 0-.65-.65 0-2.4Z" fill="#fbbf24" transform="translate(42 8.5)"/><path d="M0-2Q.55-.55 2 0 .55.55 0 2-.55.55-2 0-.55-.55 0-2Z" fill="#fde68a" opacity=".9" transform="translate(5.5 10)"/><ellipse cx="12.5" cy="14.5" rx="1.6" ry="2.6" fill="#fff" opacity=".5" transform="rotate(-30 12.5 14.5)"/></svg>',
      // 平常·拖鞋：并排两双拖鞋 + 地板光斑 + 小心心（最想回去的普通一天）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story11a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f0b429"/></linearGradient></defs><ellipse cx="15" cy="13" rx="7.5" ry="3.6" fill="#fde68a" opacity=".35"/><ellipse cx="35" cy="15" rx="6" ry="2.8" fill="#fde68a" opacity=".28"/><rect x="9.5" y="20" width="13.5" height="18.5" rx="6.7" fill="url(#story11a)"/><ellipse cx="16.2" cy="26.5" rx="3.9" ry="5.6" fill="#fffbeb"/><rect x="25" y="21.5" width="13.5" height="18.5" rx="6.7" transform="rotate(7 31.75 30.75)" fill="url(#story11a)"/><ellipse cx="32.2" cy="28" rx="3.7" ry="5.4" transform="rotate(7 32.2 28)" fill="#fffbeb"/><path d="M21 12.5c.8-1.3 2.7-1.1 3.2.3.5-1.4 2.4-1.6 3.2-.3.6 1-.3 2.3-3.2 4.2-2.9-1.9-3.8-3.2-3.2-4.2z" fill="#f9a8d4"/><ellipse cx="13" cy="35.5" rx="1.2" ry="2" fill="#fff" opacity=".5"/></svg>',
      // 一直·星轨心：金色星点连成的心形轨迹 + 底尖一颗亮星（收尾句）
      '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="story12a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><path d="M24 39.5C14 33 7.5 26.5 7.5 19.5c0-5.4 4-8.6 8.5-8.6 3.3 0 6.2 1.8 8 4.7 1.8-2.9 4.7-4.7 8-4.7 4.5 0 8.5 3.2 8.5 8.6 0 7-6.5 13.5-16.5 20z" fill="none" stroke="url(#story12a)" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="0.1 5.6"/><circle cx="24" cy="39.5" r="3.4" fill="#fde68a" opacity=".45"/><path d="M24 34.8l1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2z" fill="#fbbf24"/><path d="M7.5 19.5l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" fill="#fde68a" opacity=".9"/><path d="M40.5 19.5l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z" fill="#fde68a" opacity=".9"/><path d="M15.8 11l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z" fill="#fde68a" opacity=".8"/></svg>',
    ],
  },
};
