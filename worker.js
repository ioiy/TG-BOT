let MEMORY_CACHE = {}; // 🚀 Workers 边缘内存级别高速缓存 (防 KV 额度爆表)

export default {
  async fetch(request, env, ctx) {
    const BOT_TOKEN = env.BOT_TOKEN;
    const ADMIN_ID_ENV = env.ADMIN_ID;

    if (!BOT_TOKEN || !ADMIN_ID_ENV) {
      return new Response('请先在环境变量中配置 BOT_TOKEN 和 ADMIN_ID', { status: 500 });
    }

    const ADMIN_IDS = ADMIN_ID_ENV.split(',').map(id => id.trim());
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const WEBHOOK_SECRET = BOT_TOKEN.replace(/[^a-zA-Z0-9]/g, '').substring(0, 32); // 🛡️ 自动生成专属安全 Webhook 签名

    const tgReq = async (method, payload) => {
      const res = await fetch(`${apiUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return res.json();
    };

    const url = new URL(request.url);

    // ==========================================
    // 0. 安全图像代理（专为 OCR 设计，防泄露 BOT_TOKEN）
    // ==========================================
    if (url.pathname === '/img') {
      const secret = url.searchParams.get('secret');
      if (secret !== WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
      const file = url.searchParams.get('file');
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file}`;
      const fileRes = await fetch(fileUrl);
      return new Response(fileRes.body, { headers: { 'Content-Type': fileRes.headers.get('Content-Type') || 'image/jpeg' } });
    }

    // ==========================================
    // 1. 系统初始化 - 极致简化注册菜单
    // ==========================================
    if (request.method === 'GET' && url.pathname === '/init') {
      const webhookUrl = `https://${url.hostname}/webhook`;
      const res = await tgReq('setWebhook', { url: webhookUrl, secret_token: WEBHOOK_SECRET });

      await tgReq('setMyCommands', {
        commands: [{ command: 'start', description: '开始使用 / 呼出服务菜单' }],
        scope: { type: 'default' }
      });

      // 🌟 极简极致菜单规划：只保留最核心的系统级命令，其余全部放入 /settings 可视化面板中！
      const adminCommands = [
        { command: 'chat', description: '📱 呼出联系人面板锁定单聊' },
        { command: 'end', description: '⏹ 退出锁定单聊模式' },
        { command: 'settings', description: '⚙️ 核心防卫功能与配置控制中心' },
        { command: 'stats', description: '📊 查看系统运行状态数据' },
        { command: 'blocklog', description: '🛡️ 查看详细拦截与错误记录' }
      ];
      
      for (const adminId of ADMIN_IDS) {
        await tgReq('setMyCommands', { commands: adminCommands, scope: { type: 'chat', chat_id: adminId } });
      }

      // 默认初始化开关状态
      await env.KV.put('sys_mutantfilter', 'on');
      await env.KV.put('sys_entityfilter', 'on');
      await env.KV.put('sys_newuserfilter', 'on');
      await env.KV.put('sys_fingerprint', 'on');
      await env.KV.put('sys_langshield', 'on');
      await env.KV.put('sys_antifatigue', 'on');
      await env.KV.put('sys_captchaexpire', 'on');
      await env.KV.put('sys_whitelist', 'on');
      await env.KV.put('sys_multitier', 'on');

      return new Response(res.ok ? `✅ 初始化成功!\n1. Webhook 绑定与安全暗号生成成功: ${webhookUrl}\n2. 机器人已自动激活 10 大防御模块与可视化面板！` : `❌ 失败: ${JSON.stringify(res)}`);
    }

    // ==========================================
    // 辅助工具函数组
    // ==========================================
    const TTL = { expirationTtl: 2592000 }; // 30天自动清理

    // 高效缓存 KV 包装器
    const getCacheOrKV = async (key) => {
      const now = Date.now();
      if (MEMORY_CACHE[key] && (now - MEMORY_CACHE[key].time < 300000)) { // 5 分钟边缘内存过期
         return MEMORY_CACHE[key].val;
      }
      const val = await env.KV.get(key);
      MEMORY_CACHE[key] = { val, time: now };
      return val;
    };

    const putCacheAndKV = async (key, val, options = {}) => {
      MEMORY_CACHE[key] = { val, time: Date.now() };
      await env.KV.put(key, val, options);
    };

    const deleteCacheAndKV = async (key) => {
      delete MEMORY_CACHE[key];
      await env.KV.delete(key);
    };

    const incStat = async (key) => {
      let val = await getCacheOrKV(`stat_${key}`) || 0;
      ctx.waitUntil(putCacheAndKV(`stat_${key}`, (parseInt(val) + 1).toString()));
    };

    const addBlockLog = async (uid, name, reason, content) => {
      try {
        let logs = JSON.parse(await getCacheOrKV('log_blocks') || '[]');
        const d = new Date(Date.now() + 8 * 3600 * 1000);
        const time = `${(d.getUTCMonth()+1).toString().padStart(2,'0')}-${d.getUTCDate().toString().padStart(2,'0')} ${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')}`;
        let safeContent = (content || '').substring(0, 30);
        if (content && content.length > 30) safeContent += '...';
        logs.unshift({ time, id: uid, name, reason, content: safeContent });
        if (logs.length > 20) logs.pop(); 
        ctx.waitUntil(putCacheAndKV('log_blocks', JSON.stringify(logs)));
      } catch (e) {}
    };

    // 文本归一化归纳处理器 (防符号、繁体字、Emoji变异)
    const normalizeText = (str) => {
      if (!str) return '';
      // 1. 去除所有标点、空格、Emoji特殊字符
      let s = str.replace(/[\s\p{P}\p{S}\p{Z}]/gu, '');
      // 2. 常用变异繁体字智能映射转换
      const tradMap = {
        '線': '线', '創': '创', '購': '购', '優': '优', '單': '单', '額': '额', '賺': '赚', '匯': '汇', '錢': '钱', '備': '备', '註': '注',
        '轉': '转', '賬': '账', '驗': '验', '證': '证', '頻': '频', '道': '道', '發': '发', '群': '群', '產': '产', '廣': '广', '告': '告',
        '批': '批', '發': '发', '售': '售', '後': '后', '專': '专', '屬': '属', '量': '量', '能': '能'
      };
      for (const char in tradMap) {
        s = s.replaceAll(char, tradMap[char]);
      }
      return s.toLowerCase();
    };

    // 智能哈希指纹计算器 (SHA-256)
    const computeHash = async (message) => {
      const msgBuffer = new TextEncoder().encode(normalizeText(message));
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    };

    // 智能发送管理员面板 (自动删掉旧面板，保持界面清爽)
    const sendAdminPanel = async (chatId, text, markup = null) => {
      const lastId = await getCacheOrKV(`last_panel_${chatId}`);
      if (lastId) ctx.waitUntil(tgReq('deleteMessage', { chat_id: chatId, message_id: lastId }));
      const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
      
      const closeBtn = [{ text: '❌ 关闭面板', callback_data: 'close_panel' }];
      if (markup) {
         if (markup.inline_keyboard) markup.inline_keyboard.push(closeBtn);
         else markup.inline_keyboard = [closeBtn];
         payload.reply_markup = markup;
      } else {
         payload.reply_markup = { inline_keyboard: [closeBtn] };
      }
      
      const res = await tgReq('sendMessage', payload);
      if (res.ok) ctx.waitUntil(putCacheAndKV(`last_panel_${chatId}`, res.result.message_id.toString(), { expirationTtl: 86400 }));
    };

    // ==========================================
    // 🎭 多级可视化核心控制台渲染引擎 (主板、2级、3级)
    // ==========================================
    const renderPanel = async (chatId, menu, msgId = null) => {
      let text = "";
      const keyboard = [];

      if (menu === 'main') {
        text = "⚙️ **超级防骚扰可视化系统核心控制台**\n\n您可以使用下方按钮，免命令可视化配置整个机器人的各项拦截机制与参数：";
        keyboard.push(
          [{ text: "🛡️ 防静默安全防线 (10大开关)", callback_data: "sub_defense" }],
          [{ text: "📝 客服文案与自动回复配置", callback_data: "sub_templates" }],
          [{ text: "⛔ 违禁拦截词与过滤词库", callback_data: "sub_spam_reply" }],
          [{ text: "⚪ 进阶白名单与二级预警组", callback_data: "sub_whitelist" }],
          [{ text: "💾 系统安全备份与模式配置", callback_data: "sub_backup" }]
        );
      } 
      
      else if (menu === 'defense') {
        const keys = [
          { key: 'mutantfilter', name: '1. 文本变异归一过滤' },
          { key: 'entityfilter', name: '2. 实体精准超链拦截' },
          { key: 'newuserfilter', name: '3. 新号严管双重验证' },
          { key: 'fingerprint', name: '4. 群控指纹黑产追踪' },
          { key: 'ocrfilter', name: '5. 图像配图 AI OCR' },
          { key: 'langshield', name: '6. 外文小语种物理隔离' },
          { key: 'antifatigue', name: '7. 算术验证防疲劳锁' },
          { key: 'captchaexpire', name: '8. 超时自毁倒计时清理' },
          { key: 'whitelist', name: '9. 白名单直达通道' },
          { key: 'multitier', name: '10. 多级风险预警词库' }
        ];
        text = "🛡️ **多维防静默核心防线开关控制中心**\n\n点击下方按钮，一键切换模块：\n\n";
        for (const item of keys) {
          const status = await getCacheOrKV(`sys_${item.key}`) || 'off';
          const icon = status === 'on' ? '🟢 开启' : '🔴 关闭';
          text += `${status === 'on' ? '✅' : '❌'} **${item.name}**: ${status === 'on' ? '已激活' : '已关闭'}\n`;
          keyboard.push([{ text: `${item.name}: ${icon}`, callback_data: `toggle_${item.key}` }]);
        }
        keyboard.push([{ text: "🔙 返回核心主控台", callback_data: "settings_main" }]);
      } 
      
      else if (menu === 'templates') {
        text = "📝 **客服文案、欢迎语与话术配置中心**\n\n在这里，您可以自定义访客通过验证后的客服菜单内容，以及一键录入常用快捷回复词：";
        keyboard.push(
          [{ text: "💬 修改 访客欢迎语", callback_data: "inp_welcome" }, { text: "💰 修改 FAQ1 文案", callback_data: "inp_faq1" }],
          [{ text: "📦 修改 FAQ2 文案", callback_data: "inp_faq2" }, { text: "✨ 录入 快捷替换模板", callback_data: "inp_addtpl" }],
          [{ text: "📋 查看 快捷话术模板库", callback_data: "view_tpl" }],
          [{ text: "🔙 返回核心主控台", callback_data: "settings_main" }]
        );
      } 
      
      else if (menu === 'spam_reply') {
        text = "⛔ **黑名单敏感词、关键词自动回复库**\n\n设置拦截黑产的必杀违禁词，以及当访客触发特定关键词时的智能机器人自动应答机制：";
        keyboard.push(
          [{ text: "⛔ 添加 必杀违禁词", callback_data: "inp_addspam" }, { text: "❎ 删除 必杀违禁词", callback_data: "inp_delspam" }],
          [{ text: "📋 查看 违禁词列表", callback_data: "view_spam" }],
          [{ text: "🤖 添加 自动回复词", callback_data: "inp_addkw" }, { text: "🗑️ 删除 自动回复词", callback_data: "inp_delkw" }],
          [{ text: "📋 查看 自动回复列表", callback_data: "view_kw" }],
          [{ text: "🔙 返回核心主控台", callback_data: "settings_main" }]
        );
      } 
      
      else if (menu === 'whitelist') {
        text = "⚪ **特赦白名单与二级可疑预警词管理**\n\n白名单用户可无验证直达客服，二级预警词拦截（命中时转发上带有黄色 ⚠️ 预警标记，但不做拉黑处理）：";
        keyboard.push(
          [{ text: "⚪ 添加 绿通白名单", callback_data: "inp_addwhite" }, { text: "⚫ 移出 绿通白名单", callback_data: "inp_delwhite" }],
          [{ text: "📋 查看 当前白名单列表", callback_data: "view_white" }],
          [{ text: "⚠️ 添加 二级可疑预警词", callback_data: "inp_addwarn" }, { text: "❎ 移除 二级可疑预警词", callback_data: "inp_delwarn" }],
          [{ text: "📋 查看 预警词列表", callback_data: "view_warn" }],
          [{ text: "🔙 返回核心主控台", callback_data: "settings_main" }]
        );
      } 
      
      else if (menu === 'backup') {
        text = "💾 **全量数据库安全备份、自适应机制配置**\n\n导出或恢复全量配置（备注、备注库、规则、开关白名单等），或在自适应遭遇战时锁定特定的验证码样式：";
        keyboard.push(
          [{ text: "💾 导出全量 JSON 备份", callback_data: "act_backup" }],
          [{ text: "⚙️ 弹性验证模式与容错参数", callback_data: "sub_captcha_cfg" }],
          [{ text: "🔙 返回核心主控台", callback_data: "settings_main" }]
        );
      } 
      
      else if (menu === 'captcha_cfg') {
        const type = await getCacheOrKV('sys_captcha_type') || 'random';
        const fails = await getCacheOrKV('sys_maxfails') || '3';
        text = `⚙️ **自适应验证码与容错防守策略**\n\n当前验证模式：\`${type}\`\n最大错误拉黑阈值：\`${fails}\` 次\n\n点击下方按钮快速切换或修改阈值参数：`;
        keyboard.push(
          [{ text: `模式: 随机自适应 ${type==='random'?'✅':''}`, callback_data: "setcap_random" }],
          [{ text: `模式: 数值算术题 ${type==='math'?'✅':''}`, callback_data: "setcap_math" }],
          [{ text: `模式: 视觉找符号 ${type==='find'?'✅':''}`, callback_data: "setcap_find" }],
          [{ text: `模式: 水果计数器 ${type==='fruit'?'✅':''}`, callback_data: "setcap_fruit" }],
          [{ text: "⛔ 修改 连续点错拉黑次数", callback_data: "inp_maxfails" }],
          [{ text: "🔙 返回备份与机制页面", callback_data: "sub_backup" }]
        );
      }

      const payload = {
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [...keyboard, [{ text: '❌ 关闭控制台', callback_data: 'close_panel' }]] }
      };

      if (msgId) {
        await tgReq('editMessageText', { chat_id: chatId, message_id: msgId, ...payload });
      } else {
        await sendAdminPanel(chatId, text, payload.reply_markup);
      }
    };

    // 访客自助 FAQ 菜单键盘
    const faqKeyboard = {
      inline_keyboard: [
        [{ text: '💰 常见问题与价格', callback_data: 'faq_1' }],
        [{ text: '📦 发货与售后说明', callback_data: 'faq_2' }],
        [{ text: '🙋 呼叫人工客服', callback_data: 'faq_human' }]
      ]
    };

    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
         return new Response('Unauthorized', { status: 401 });
      }

      let update;
      try { update = await request.json(); } catch (e) { return new Response('Bad Request'); }

      // ==========================================
      // 【特殊事件：Channel/Group Join Request 自动拦截验证 (Feature 4)】
      // ==========================================
      if (update.chat_join_request) {
        const req = update.chat_join_request;
        const uid = req.from.id.toString();
        const chatId = req.chat.id.toString();
        const chatTitle = req.chat.title || '群组/频道';
        const userName = [req.from.first_name, req.from.last_name].filter(Boolean).join(' ') || '未知用户';

        await putCacheAndKV(`join_req_${uid}`, chatId, { expirationTtl: 3600 });
        
        const options = [
           { text: '🚗', callback_data: `joinpass_${uid}` },
           { text: '🍏', callback_data: `joinfail_${uid}` },
           { text: '🏠', callback_data: `joinfail_${uid}` }
        ].sort(() => Math.random() - 0.5);

        await tgReq('sendMessage', {
           chat_id: uid,
           text: `🤖 **入群申请安全验证**\n\n👤 **${userName}** 您好！欢迎申请加入 [${chatTitle}]。\n为防范黑产脚本大军，请点按下方按钮，选出：**🚗** 进行安全解锁。`,
           reply_markup: { inline_keyboard: [options] }
        });
        return new Response('OK');
      }

      // ==========================================
      // 1. 处理回调查询 (按钮点击)
      // ==========================================
      if (update.callback_query) {
        const cb = update.callback_query;
        const userId = cb.from.id.toString();
        const isAdmin = ADMIN_IDS.includes(userId);
        const isOwner = ADMIN_IDS[0] === userId; // Feature 8: Owner 所有者判断
        const userName = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' ') || '未知用户';
        const lang = cb.from.language_code || 'en';
        const isZh = lang.startsWith('zh');

        if (await getCacheOrKV(`banned_${userId}`)) return new Response('OK');

        if (cb.data === 'close_panel') {
          await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
          return new Response('OK');
        }

        // --- 🎭 导航/二级菜单控制响应组 ---
        if (cb.data === 'settings_main') { await renderPanel(userId, 'main', cb.message.message_id); return new Response('OK'); }
        if (cb.data === 'sub_defense') { await renderPanel(userId, 'defense', cb.message.message_id); return new Response('OK'); }
        if (cb.data === 'sub_templates') { await renderPanel(userId, 'templates', cb.message.message_id); return new Response('OK'); }
        if (cb.data === 'sub_spam_reply') { await renderPanel(userId, 'spam_reply', cb.message.message_id); return new Response('OK'); }
        if (cb.data === 'sub_whitelist') { await renderPanel(userId, 'whitelist', cb.message.message_id); return new Response('OK'); }
        if (cb.data === 'sub_backup') { await renderPanel(userId, 'backup', cb.message.message_id); return new Response('OK'); }
        if (cb.data === 'sub_captcha_cfg') { await renderPanel(userId, 'captcha_cfg', cb.message.message_id); return new Response('OK'); }

        // --- Feature 8: 权限隔离——只有 Owner 拥有 Settings 开关配置权 ---
        if (cb.data.startsWith('toggle_')) {
          if (!isOwner) {
             await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '⚠️ 权限不足：只有 Owner(所有者) 可以配置系统开关！', show_alert: true });
             return new Response('OK');
          }
          const key = cb.data.replace('toggle_', '');
          const cur = await getCacheOrKV(`sys_${key}`) || 'off';
          const next = cur === 'on' ? 'off' : 'on';
          await putCacheAndKV(`sys_${key}`, next);
          await renderPanel(userId, 'defense', cb.message.message_id);
          return new Response('OK');
        }

        // --- 验证码模式一键切换 ---
        if (cb.data.startsWith('setcap_')) {
          if (!isOwner) {
             await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '⚠️ 权限不足！', show_alert: true });
             return new Response('OK');
          }
          const mode = cb.data.replace('setcap_', '');
          await putCacheAndKV('sys_captcha_type', mode);
          await renderPanel(userId, 'captcha_cfg', cb.message.message_id);
          return new Response('OK');
        }

        // --- 🎭 激活人机输入交互状态 (Stateful Inputs) ---
        if (cb.data.startsWith('inp_')) {
          const action = cb.data.replace('inp_', '');
          const configNames = {
             welcome: "自定义欢迎语文案", faq1: "FAQ1 (常见问题) 文案", faq2: "FAQ2 (发货说明) 文案",
             addtpl: "快捷短语替换模板 (请输入格式：#模板指令|完整回复文本，例如 #pay|波场地址)",
             addspam: "必杀违禁封禁词 (命中后即时封杀)", delspam: "要删除的违禁词",
             addkw: "自动回复关键词 (请输入格式：关键词|机器人回复文本)", delkw: "要删除的自动回复关键词",
             addwhite: "白名单绿通用户 ID", delwhite: "要从白名单中移出的用户 ID",
             addwarn: "二级可疑预警词 (仅报警不封杀)", delwarn: "要移除的二级预警词",
             maxfails: "容错验证点错即拉黑次数 (限整数)", broadcast: "全量广告群发内容 (支持发送任意带图/视频的文案)"
          };
          
          await putCacheAndKV(`input_state_${userId}`, `state_${action}`, { expirationTtl: 300 });
          await tgReq('sendMessage', {
             chat_id: userId,
             text: `📝 **人机交互输入指令模式激活**\n\n请输入：**${configNames[action]}** 并直接在下方框中发送给机器人。\n\n*💡 提示：输入 \`cancel\` 可以随时退出输入状态并返回主菜单。*`,
             parse_mode: 'Markdown'
          });
          return new Response('OK');
        }

        // --- 🎭 可视化查看文本列表指令组 ---
        if (cb.data.startsWith('view_')) {
          const action = cb.data.replace('view_', '');
          let listText = "";
          if (action === 'tpl') {
             let templates = JSON.parse(await getCacheOrKV('reply_templates') || '{}');
             listText = "📋 **当前快捷话术模板库:**\n\n" + (Object.keys(templates).map(k => `- \`${k}\` -> ${templates[k]}`).join('\n') || '无记录');
          } else if (action === 'spam') {
             let spamList = JSON.parse(await getCacheOrKV('spam_keywords') || '[]');
             listText = "📋 **当前违禁黑名单词库:**\n\n" + (spamList.map(w => `- ${w}`).join('\n') || '无记录');
          } else if (action === 'kw') {
             let kwMap = JSON.parse(await getCacheOrKV('auto_keywords') || '{}');
             listText = "📋 **当前关键词自动应答回复库:**\n\n" + (Object.keys(kwMap).map(k => `- ${k} -> ${kwMap[k]}`).join('\n') || '无记录');
          } else if (action === 'white') {
             let wList = JSON.parse(await getCacheOrKV('whitelist_users') || '[]');
             listText = "📋 **当前绿通直连白名单 ID 列表:**\n\n" + (wList.map(id => `- \`${id}\``).join('\n') || '无记录');
          } else if (action === 'warn') {
             let warnList = JSON.parse(await getCacheOrKV('warn_keywords') || '[]');
             listText = "📋 **当前二级高危可疑预警词库:**\n\n" + (warnList.map(w => `- ${w}`).join('\n') || '无记录');
          }
          await sendAdminPanel(userId, listText);
          return new Response('OK');
        }

        // --- 💾 全量数据安全备份与一键秒级导出 ---
        if (cb.data === 'act_backup') {
          if (!isOwner) {
             await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '⚠️ 权限不足：只有 Owner 可以备份全量数据。' });
             return new Response('OK');
          }
          const keys = await env.KV.list();
          const data = {};
          for (const key of keys.keys) {
             data[key.name] = await env.KV.get(key.name);
          }
          const jsonStr = JSON.stringify(data, null, 2);
          const blob = new Blob([jsonStr], { type: 'application/json' });
          const formData = new FormData();
          formData.append('chat_id', userId);
          formData.append('document', blob, 'tg_bot_backup.json');
          formData.append('caption', '💾 **机器人全量数据库一键备份打包成功**\n\n如需还原，只需**回复（Reply）此备份文件**并输入 \`/restore\` 指令，即可 1 秒完全恢复！');
          
          await fetch(`${apiUrl}/sendDocument`, { method: 'POST', body: formData });
          return new Response('OK');
        }

        // --- 申请入群批准验证响应 ---
        if (cb.data.startsWith('joinpass_')) {
          const targetUid = cb.data.replace('joinpass_', '');
          const pendingChatId = await getCacheOrKV(`join_req_${targetUid}`);
          if (pendingChatId) {
             const appRes = await tgReq('approveChatJoinRequest', { chat_id: pendingChatId, user_id: parseInt(targetUid) });
             if (appRes.ok) {
                await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: '✅ **验证成功！已自动为您批准入群申请，欢迎加入！**' });
             } else {
                await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: `⚠️ 验证已通过，但批准入群时发生错误: ${appRes.description}` });
             }
             await deleteCacheAndKV(`join_req_${targetUid}`);
          }
          return new Response('OK');
        }
        if (cb.data.startsWith('joinfail_')) {
          await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: '❌ **安全验证失败，入群申请已被自动忽略，请重新申请。**' });
          return new Response('OK');
        }

        // --- 特赦解封并自动加白名单一键直达 (Feature 2) ---
        if (cb.data.startsWith('unban_')) {
          const targetId = cb.data.replace('unban_', '');
          await deleteCacheAndKV(`banned_${targetId}`);
          await putCacheAndKV(`user_${targetId}`, 'verified', TTL);
          
          let wList = JSON.parse(await getCacheOrKV('whitelist_users') || '[]');
          if (!wList.includes(targetId)) wList.push(targetId);
          await putCacheAndKV('whitelist_users', JSON.stringify(wList));

          await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: `✅ 已经成功赦免并加白用户: ${targetId}`, show_alert: true });
          await tgReq('editMessageReplyMarkup', { chat_id: userId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
          return new Response('OK');
        }

        // --- 访客自助 FAQ 菜单交互 ---
        else if (cb.data.startsWith('faq_')) {
          const action = cb.data.replace('faq_', '');
          if (action === 'menu') {
            await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: '👇 **自助服务菜单**\n请选择您需要了解的内容：', parse_mode: 'Markdown', reply_markup: faqKeyboard });
          } else if (action === '1') {
            const faq1Text = await getCacheOrKV('faq_1_text') || '💰 **常见问题与价格**\n\n默认文案。管理员请在 `/settings` 可视化控制台中修改。';
            await tgReq('editMessageText', { 
              chat_id: userId, message_id: cb.message.message_id, text: faq1Text, 
              parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 返回菜单', callback_data: 'faq_menu' }]] } 
            });
          } else if (action === '2') {
            const faq2Text = await getCacheOrKV('faq_2_text') || '📦 **发货与售后说明**\n\n默认文案。管理员请在 `/settings` 可视化控制台中修改。';
            await tgReq('editMessageText', { 
              chat_id: userId, message_id: cb.message.message_id, text: faq2Text, 
              parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 返回菜单', callback_data: 'faq_menu' }]] } 
            });
          } else if (action === 'human') {
            await tgReq('editMessageText', { 
              chat_id: userId, message_id: cb.message.message_id, 
              text: '👩‍💻 **已为您接通人工客服**\n\n请直接在下方输入您的问题，主人收到后会尽快回复您！', parse_mode: 'Markdown' 
            });
          }
        }

        // --- 锁定访客后的完全卡片交互功能 (备注, 拉黑, 删除, 阅后即焚, 查看历史) ---
        else if (cb.data.startsWith('qnote_')) {
          const targetId = cb.data.replace('qnote_', '');
          await putCacheAndKV(`input_state_${userId}`, `state_note_${targetId}`, { expirationTtl: 300 });
          await tgReq('sendMessage', { chat_id: userId, text: `📝 **人机交互模式激活**\n\n请输入给该用户 (\`${targetId}\`) 的新备注名称，并直接发送：` });
        } else if (cb.data.startsWith('qburn_')) {
          const targetId = cb.data.replace('qburn_', '');
          await putCacheAndKV(`input_state_${userId}`, `state_burn_${targetId}`, { expirationTtl: 300 });
          await tgReq('sendMessage', { chat_id: userId, text: `🔥 **人机交互阅后即焚激活**\n\n请输入要发给对方的**剧透版阅后即焚文本内容**，并直接发送：` });
        } else if (cb.data.startsWith('qhistory_')) {
          const targetId = cb.data.replace('qhistory_', '');
          const historyStr = await getCacheOrKV(`history_${targetId}`) || '[]';
          const reply = JSON.parse(historyStr).length ? JSON.parse(historyStr).map((m, i) => `${i+1}. ${m}`).join('\n') : '暂无文本聊天记录。';
          await sendAdminPanel(userId, `🕒 **该用户历史最后 5 条记录**\n\n${reply}`);
        } else if (cb.data.startsWith('qdel_')) {
          const targetId = cb.data.replace('qdel_', '');
          await deleteCacheAndKV(`user_info_${targetId}`);
          await deleteCacheAndKV(`history_${targetId}`);
          await deleteCacheAndKV(`note_${targetId}`);
          if (await getCacheOrKV(`active_chat_${userId}`) === targetId) {
              await deleteCacheAndKV(`active_chat_${userId}`);
          }
          await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '🗑️ 成功：已将该访客从联系人列表中移除', show_alert: true });
          await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
        } else if (cb.data.startsWith('qban_')) {
          const targetId = cb.data.replace('qban_', '');
          await putCacheAndKV(`banned_${targetId}`, 'true');
          await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '🚫 拦截成功：已将该用户永久拉黑', show_alert: true });
          await tgReq('editMessageReplyMarkup', { chat_id: userId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
        } else if (cb.data === 'clear_stats') {
          await deleteCacheAndKV('stat_verified');
          await deleteCacheAndKV('stat_blocked');
          await deleteCacheAndKV('stat_msgs');
          await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '🧹 所有统计数据已清零！', show_alert: true });
          await sendAdminPanel(userId, '📊 统计数据已被手动清空。');
        } else if (cb.data === 'bc_confirm') {
          const bcMsgId = await getCacheOrKV(`pending_bc_${userId}`);
          if (!bcMsgId) return new Response('OK');
          await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: '⏳ 正在拼命群发中，请稍候...' });
          let count = 0;
          for (const k of (await env.KV.list({ prefix: 'user_' })).keys) {
            if (!k.name.startsWith('user_info_')) {
              ctx.waitUntil(tgReq('copyMessage', { chat_id: k.name.replace('user_', ''), from_chat_id: userId, message_id: bcMsgId }));
              count++;
            }
          }
          await deleteCacheAndKV(`pending_bc_${userId}`);
          await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
          await sendAdminPanel(userId, `✅ **广播完成**\n\n已成功将该消息投递给 ${count} 位联系人。`);
        } else if (cb.data === 'bc_cancel') {
          await deleteCacheAndKV(`pending_bc_${userId}`);
          await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
          await sendAdminPanel(userId, '❌ 广播任务已取消。');
        } else if (cb.data === 'captcha_pass') {
          // 最终验证通过
          await putCacheAndKV(`user_${userId}`, 'verified', TTL);
          ctx.waitUntil(putCacheAndKV(`user_info_${userId}`, userName, TTL));
          ctx.waitUntil(incStat('verified'));
          
          await tgReq('editMessageText', { 
            chat_id: userId, message_id: cb.message.message_id, 
            text: isZh ? '✅ **验证通过！**\n\n请选择您需要的服务，或直接输入消息发送给人工客服：' : '✅ **Verified!**\n\nPlease select a service or type a message directly:',
            parse_mode: 'Markdown', reply_markup: faqKeyboard
          });
        } else if (cb.data === 'captcha_fail') {
          ctx.waitUntil(incStat('blocked'));
          let fails = parseInt(await getCacheOrKV(`fails_${userId}`) || '0') + 1;
          await putCacheAndKV(`fails_${userId}`, fails.toString(), { expirationTtl: 86400 });
          
          let maxFails = parseInt(await getCacheOrKV('sys_maxfails') || '3');
          if (fails >= maxFails) {
            await putCacheAndKV(`banned_${userId}`, 'true');
            ctx.waitUntil(addBlockLog(userId, userName, '多次验证错误拉黑', `连续失败 ${fails} 次`));
            await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: isZh ? '🚫 **验证失败次数过多，您已被永久拦截。**' : '🚫 **Too many failed attempts. Blocked.**', parse_mode: 'Markdown' });
            
            const alertOn = await getCacheOrKV('sys_spamalert') !== 'off';
            if (alertOn) {
                const quickUnban = { inline_keyboard: [[{ text: '✅ 一键恢复加白', callback_data: `unban_${userId}` }]] };
                for (const admin of ADMIN_IDS) {
                   ctx.waitUntil(tgReq('sendMessage', { chat_id: admin, text: `🛡️ **防刷报警**\n\n访客 👤 **${userName}** (\`${userId}\`) 连续 ${fails} 次验证错误，已被自动拉黑。`, parse_mode: 'Markdown', reply_markup: quickUnban }));
                }
            }
          } else {
            ctx.waitUntil(addBlockLog(userId, userName, '验证码错误', `第 ${fails} 次选错`));
            await tgReq('answerCallbackQuery', { 
               callback_query_id: cb.id, 
               text: isZh ? `❌ 选错啦，请重试！\n(警告: 错误 ${maxFails} 次将被永久拉黑，当前 ${fails} 次)` : '❌ Wrong answer, try again', 
               show_alert: true 
            });
          }
        }
        return new Response('OK');
      }

      // ==========================================
      // 2. 处理普通消息
      // ==========================================
      if (update.message) {
        // Feature 3: 非私聊场景自动退群隔离保护
        if (update.message.chat.type !== 'private') {
           await tgReq('leaveChat', { chat_id: update.message.chat.id });
           for (const admin of ADMIN_IDS) {
               ctx.waitUntil(tgReq('sendMessage', { chat_id: admin, text: `🛡️ **群组隔离保护**\n\n机器人检测到非私聊环境，已自动退出群组: ${update.message.chat.title || '未知群'} (${update.message.chat.id})` }));
           }
           return new Response('OK');
        }

        const msg = update.message;
        const userId = msg.from.id.toString();
        const msgId = msg.message_id;
        const isAdmin = ADMIN_IDS.includes(userId);
        const isOwner = ADMIN_IDS[0] === userId;
        const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || '未知用户';

        // ----------------------------------------
        // 【管理员核心逻辑】
        // ----------------------------------------
        if (isAdmin) {
          const text = (msg.text || msg.caption || '').trim();

          // A. 🎯 状态机交互拦截逻辑 (完全取消了传统的 Slash 输入配置指令)
          const inputState = await getCacheOrKV(`input_state_${userId}`);
          if (inputState && text) {
             ctx.waitUntil(tgReq('deleteMessage', { chat_id: userId, message_id: msgId }));
             await deleteCacheAndKV(`input_state_${userId}`);

             if (text.toLowerCase() === 'cancel' || text === '取消') {
                await sendAdminPanel(userId, "❌ 已成功退出输入状态，无任何更改。");
                await renderPanel(userId, 'main');
                return new Response('OK');
             }

             // 文案与模板类状态修改
             if (inputState === 'state_welcome') {
                await putCacheAndKV('welcome_msg', text);
                await sendAdminPanel(userId, "✅ 欢迎语配置修改更新成功！");
                await renderPanel(userId, 'templates');
             } else if (inputState === 'state_faq1') {
                await putCacheAndKV('faq_1_text', text);
                await sendAdminPanel(userId, "✅ FAQ1 (常见问题) 配置修改成功！");
                await renderPanel(userId, 'templates');
             } else if (inputState === 'state_faq2') {
                await putCacheAndKV('faq_2_text', text);
                await sendAdminPanel(userId, "✅ FAQ2 (发货售后) 配置修改成功！");
                await renderPanel(userId, 'templates');
             } else if (inputState === 'state_addtpl') {
                const parts = text.split('|');
                if (parts.length >= 2) {
                   const shortcut = parts[0].trim();
                   const tplVal = parts.slice(1).join('|').trim();
                   if (!shortcut.startsWith('#')) {
                      await tgReq('sendMessage', { chat_id: userId, text: "⚠️ 录入失败：快捷键指令必须以 `#` 开头。例如 `#pay|地址`" });
                   } else {
                      let templates = JSON.parse(await getCacheOrKV('reply_templates') || '{}');
                      templates[shortcut] = tplVal;
                      await putCacheAndKV('reply_templates', JSON.stringify(templates));
                      await sendAdminPanel(userId, `✅ 话术替换词 \`${shortcut}\` 录入存储成功！`);
                   }
                } else {
                   await tgReq('sendMessage', { chat_id: userId, text: "⚠️ 格式错误，请按照 `关键词|回复内容` 的格式再次录入。" });
                }
                await renderPanel(userId, 'templates');
             }
             
             // 过滤规则与应答词
             else if (inputState === 'state_addspam') {
                let spamList = JSON.parse(await getCacheOrKV('spam_keywords') || '[]');
                if (!spamList.includes(text)) spamList.push(text);
                await putCacheAndKV('spam_keywords', JSON.stringify(spamList));
                await sendAdminPanel(userId, `⛔ 成功新增必杀违禁过滤词: **${text}**`);
                await renderPanel(userId, 'spam_reply');
             } else if (inputState === 'state_delspam') {
                let spamList = JSON.parse(await getCacheOrKV('spam_keywords') || '[]');
                spamList = spamList.filter(w => w !== text);
                await putCacheAndKV('spam_keywords', JSON.stringify(spamList));
                await sendAdminPanel(userId, `❎ 成功移出黑名单词: **${text}**`);
                await renderPanel(userId, 'spam_reply');
             } else if (inputState === 'state_addkw') {
                const parts = text.split('|');
                if (parts.length >= 2) {
                   const kw = parts[0].trim();
                   const ans = parts.slice(1).join('|').trim();
                   let kwMap = JSON.parse(await getCacheOrKV('auto_keywords') || '{}');
                   kwMap[kw] = ans;
                   await putCacheAndKV('auto_keywords', JSON.stringify(kwMap));
                   await sendAdminPanel(userId, `🤖 新增自动关键词回复成功：\`${kw}\``);
                } else {
                   await tgReq('sendMessage', { chat_id: userId, text: "⚠️ 格式错误，请按：`关键词|回复` 的格式重新录入。" });
                }
                await renderPanel(userId, 'spam_reply');
             } else if (inputState === 'state_delkw') {
                let kwMap = JSON.parse(await getCacheOrKV('auto_keywords') || '{}');
                delete kwMap[text];
                await putCacheAndKV('auto_keywords', JSON.stringify(kwMap));
                await sendAdminPanel(userId, `🗑️ 已删除自动回复应答词: **${text}**`);
                await renderPanel(userId, 'spam_reply');
             }

             // 白名单与预警词
             else if (inputState === 'state_addwhite') {
                let wList = JSON.parse(await getCacheOrKV('whitelist_users') || '[]');
                if (!wList.includes(text)) wList.push(text);
                await putCacheAndKV('whitelist_users', JSON.stringify(wList));
                await sendAdminPanel(userId, `⚪ 用户 \`${text}\` 已加入免审白名单中。`);
                await renderPanel(userId, 'whitelist');
             } else if (inputState === 'state_delwhite') {
                let wList = JSON.parse(await getCacheOrKV('whitelist_users') || '[]');
                wList = wList.filter(id => id !== text);
                await putCacheAndKV('whitelist_users', JSON.stringify(wList));
                await sendAdminPanel(userId, `⚫ 用户 \`${text}\` 已从白名单中移出。`);
                await renderPanel(userId, 'whitelist');
             } else if (inputState === 'state_addwarn') {
                let warnList = JSON.parse(await getCacheOrKV('warn_keywords') || '[]');
                if (!warnList.includes(text)) warnList.push(text);
                await putCacheAndKV('warn_keywords', JSON.stringify(warnList));
                await sendAdminPanel(userId, `⚠️ 二级高危警告预警词 \`${text}\` 录入成功！`);
                await renderPanel(userId, 'whitelist');
             } else if (inputState === 'state_delwarn') {
                let warnList = JSON.parse(await getCacheOrKV('warn_keywords') || '[]');
                warnList = warnList.filter(w => w !== text);
                await putCacheAndKV('warn_keywords', JSON.stringify(warnList));
                await sendAdminPanel(userId, `❎ 二级预警词 \`${text}\` 移除成功。`);
                await renderPanel(userId, 'whitelist');
             }

             // 策略与参数
             else if (inputState === 'state_maxfails') {
                const num = parseInt(text);
                if (!isNaN(num) && num > 0) {
                   await putCacheAndKV('sys_maxfails', num.toString());
                   await sendAdminPanel(userId, `✅ 最大容错黑名单点错次数成功修改为：**${num}** 次！`);
                } else {
                   await tgReq('sendMessage', { chat_id: userId, text: "⚠️ 输入无效，必须是一个正整数，请重新输入。" });
                }
                await renderPanel(userId, 'captcha_cfg');
             }

             // 广播全量投递
             else if (inputState === 'state_broadcast') {
                await putCacheAndKV(`pending_bc_${userId}`, msgId.toString(), { expirationTtl: 600 });
                await sendAdminPanel(userId, `📢 **广播发送确认**\n\n将把你的这条消息原封不动（支持带图/视频）群发给所有人。\n是否确认发送？`, {
                   inline_keyboard: [[{ text: '✅ 确认发送', callback_data: 'bc_confirm' }, { text: '❌ 取消', callback_data: 'bc_cancel' }]]
                });
             }

             // 精准卡片备注修改状态
             else if (inputState.startsWith('state_note_')) {
                const targetId = inputState.replace('state_note_', '');
                await putCacheAndKV(`note_${targetId}`, text);
                await sendAdminPanel(userId, `📝 已将 \`${targetId}\` 成功备注为: **${text}**`);
             }

             // 精准卡片阅后即焚内容发送
             else if (inputState.startsWith('state_burn_')) {
                const targetId = inputState.replace('state_burn_', '');
                await tgReq('sendMessage', { 
                  chat_id: targetId, 
                  text: `🔥 <b>阅后即焚消息</b>\n\n<tg-spoiler>${text}</tg-spoiler>\n\n<i>(请手动点击马赛克区域查看内容)</i>`, 
                  parse_mode: 'HTML' 
                });
                await tgReq('sendMessage', { chat_id: userId, text: `🔥 剧透保护消息已成功发送至对方账号。` });
             }

             return new Response('OK');
          }

          // B. 📚 正常菜单 Slash 核心指令响应 (剔除了以前大量冗杂繁重的 Slash 选项)
          if (text) {
            const cmd = text.split(' ')[0];

            if (text.startsWith('/')) {
               ctx.waitUntil(tgReq('deleteMessage', { chat_id: userId, message_id: msgId }));
            }

            // --- Feature 5: # 快捷短语模板一键秒级回复 ---
            if (text.startsWith('#')) {
               const shortcut = text.split(' ')[0];
               const templates = JSON.parse(await getCacheOrKV('reply_templates') || '{}');
               if (templates[shortcut]) {
                  const activeChat = await getCacheOrKV(`active_chat_${userId}`);
                  if (activeChat) {
                     await tgReq('sendMessage', { chat_id: activeChat, text: templates[shortcut] });
                     await sendAdminPanel(userId, `✅ **快捷模板一键替换发送成功！**\n\n- 缩写: \`${shortcut}\`\n- 正文: ${templates[shortcut]}`);
                     return new Response('OK');
                  }
               }
            }

            if (cmd === '/chat' || cmd === '/list') {
              const listRes = await env.KV.list({ prefix: 'user_info_' });
              const keyboard = [];
              for (const k of listRes.keys) {
                if (keyboard.length >= 20) break;
                const uid = k.name.replace('user_info_', '');
                if (await getCacheOrKV(`banned_${uid}`)) continue;
                const uname = await getCacheOrKV(k.name) || '未知';
                const note = await getCacheOrKV(`note_${uid}`);
                keyboard.push([{ text: note ? `📝 ${note}` : `👤 ${uname}`, callback_data: `setchat_${uid}` }]);
              }
              await sendAdminPanel(userId, keyboard.length ? '👇 **请选择要锁定并对话的联系人：**' : '暂无联系人记录。', { inline_keyboard: keyboard });
              return new Response('OK');
            }
            
            if (cmd === '/end') {
              await deleteCacheAndKV(`active_chat_${userId}`);
              await sendAdminPanel(userId, '⏹ 已退出锁定单聊对话模式。');
              return new Response('OK');
            }

            if (cmd === '/settings') {
              await renderPanel(userId, 'main');
              return new Response('OK');
            }

            if (cmd === '/stats') {
              const verified = await getCacheOrKV('stat_verified') || 0;
              const blocked = await getCacheOrKV('stat_blocked') || 0;
              const msgs = await getCacheOrKV('stat_msgs') || 0;
              const dnd = await getCacheOrKV('sys_dnd') === 'on' ? '开启 🟢' : '关闭 🔴';
              const media = await getCacheOrKV('sys_mediafilter') === 'on' ? '开启 (拦截媒体) 🟢' : '关闭 🔴';
              const statText = `📊 **系统运行统计**\n\n✅ 已验证人数: \`${verified}\`\n🚫 拦截总次数: \`${blocked}\`\n💬 处理消息总数: \`${msgs}\`\n\n🔕 免打扰模式: ${dnd}\n🖼️ 纯文本模式: ${media}\n\n👉 发送 \`/blocklog\` 查看最新详细拦截记录。`;
              await sendAdminPanel(userId, statText, { inline_keyboard: [[{ text: '🧹 清空所有统计数据', callback_data: 'clear_stats' }]] });
              return new Response('OK');
            }

            if (cmd === '/blocklog' || cmd === '/logs') {
              const logsStr = await getCacheOrKV('log_blocks');
              if (!logsStr || JSON.parse(logsStr).length === 0) {
                await sendAdminPanel(userId, '📭 暂无近期拦截与错误记录。');
                return new Response('OK');
              }
              const reply = JSON.parse(logsStr).map((l, i) => `${i+1}. [${l.time}] 👤 **${l.name}** (\`${l.id}\`)\n   🚫 ${l.reason}: _${l.content}_`).join('\n\n');
              await sendAdminPanel(userId, `🛡️ **近期拦截详情溯源 (最近20条)**\n\n${reply}`);
              return new Response('OK');
            }

            // --- Feature 9: 回复备份文件一键导入还原 ---
            if (cmd === '/restore' && msg.reply_to_message?.document) {
               if (!isOwner) {
                  await tgReq('sendMessage', { chat_id: userId, text: '⚠️ 权限不足：只有 Owner 可以恢复全量数据。' });
                  return new Response('OK');
               }
               const doc = msg.reply_to_message.document;
               const fileRes = await tgReq('getFile', { file_id: doc.file_id });
               if (fileRes.ok) {
                  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileRes.result.file_path}`;
                  const dataRes = await fetch(fileUrl);
                  const data = await dataRes.json();
                  for (const key in data) {
                     await putCacheAndKV(key, data[key]);
                  }
                  await sendAdminPanel(userId, '✅ **全量数据一键恢复导入成功！全量配置、白名单、违禁词、备注库已完美同步。**');
               }
               return new Response('OK');
            }
          }

          // 回复直接转发
          if (msg.reply_to_message && msg.reply_to_message.forward_from) {
            await tgReq('copyMessage', { chat_id: msg.reply_to_message.forward_from.id, from_chat_id: userId, message_id: msgId });
            return new Response('OK');
          } else if (msg.reply_to_message && !msg.reply_to_message.forward_from) {
            const textMatch = msg.reply_to_message.text ? msg.reply_to_message.text.match(/\(`(\d+)`\)/) : null;
            if (textMatch && textMatch[1]) {
               await tgReq('copyMessage', { chat_id: textMatch[1], from_chat_id: userId, message_id: msgId });
               return new Response('OK');
            }
          }

          // 锁定聊天状态发送
          const activeChat = await getCacheOrKV(`active_chat_${userId}`);
          if (activeChat) {
            await tgReq('copyMessage', { chat_id: activeChat, from_chat_id: userId, message_id: msgId });
          } else if (!text.startsWith('/')) {
            await tgReq('sendMessage', { chat_id: userId, text: 'ℹ️ **操作提示**\n当前未锁定聊天对象。请发送 `/chat`，或左滑回复用户消息。', parse_mode: 'Markdown' });
          }
          return new Response('OK');
        }

        // ----------------------------------------
        // 【普通访客逻辑】
        // ----------------------------------------
        ctx.waitUntil(incStat('msgs'));

        // Feature 9: 白名单机制
        const isWhitelistOn = await getCacheOrKV('sys_whitelist') === 'on';
        if (isWhitelistOn) {
           const wList = JSON.parse(await getCacheOrKV('whitelist_users') || '[]');
           if (wList.includes(userId)) {
              for (const admin of ADMIN_IDS) {
                 await tgReq('copyMessage', { chat_id: admin, from_chat_id: userId, message_id: msgId });
              }
              return new Response('OK');
           }
        }

        // 1. 黑名单检查
        if (await getCacheOrKV(`banned_${userId}`)) {
           ctx.waitUntil(incStat('blocked'));
           ctx.waitUntil(addBlockLog(userId, userName, '黑名单拦截', msg.text || '[媒体消息]'));
           return new Response('OK');
        }

        // 2. 媒体拦截检查
        let mediaDesc = "";
        if (msg.photo) mediaDesc = "🖼️ 照片";
        else if (msg.voice) mediaDesc = "🎤 语音留言";
        else if (msg.video) mediaDesc = "🎬 视频";
        else if (msg.document) mediaDesc = "📄 文件";
        else if (msg.sticker) mediaDesc = "👾 贴纸";
        else if (msg.audio) mediaDesc = "🎵 音乐/音频";
        else if (msg.animation) mediaDesc = "🎞️ GIF动图";
        
        const mediaFilterOn = await getCacheOrKV('sys_mediafilter') === 'on';
        if (mediaFilterOn && mediaDesc !== "") {
           ctx.waitUntil(incStat('blocked'));
           ctx.waitUntil(addBlockLog(userId, userName, '媒体拦截', `尝试发送 ${mediaDesc}`));
           const lang = msg.from.language_code || 'en';
           await tgReq('sendMessage', { 
             chat_id: userId, 
             text: lang.startsWith('zh') ? `⚠️ 主人已开启纯文本模式，已被拦截发送 ${mediaDesc}。` : '⚠️ Owner only accepts text messages currently.',
             reply_to_message_id: msgId 
           });
           return new Response('OK');
        }

        // 3. 验证状态检查
        const isVerified = await getCacheOrKV(`user_${userId}`);
        const lang = msg.from.language_code || 'en';
        const isZh = lang.startsWith('zh');

        if (msg.text === '/start') {
           if (isVerified === 'verified') {
             await tgReq('sendMessage', { chat_id: userId, text: isZh ? '👇 **自助服务菜单**\n您可以自助查询，或直接输入消息发送给人工客服：' : '👇 **Service Menu**', reply_markup: faqKeyboard, parse_mode: 'Markdown' });
             return new Response('OK');
           }
        }

        if (isVerified === 'verified') {
          // Feature 7: 刷屏限流防卫 (10分钟冷冻)
          if (await getCacheOrKV(`flood_banned_${userId}`)) return new Response('OK');

          ctx.waitUntil(putCacheAndKV(`user_info_${userId}`, userName, TTL)); // 刷新活跃度
          const note = await getCacheOrKV(`note_${userId}`);
          const display = note ? `${note} (原名: ${userName})` : userName;

          // 频率判定
          let rateStr = await getCacheOrKV(`rate_${userId}`) || '[]';
          let rateArr = JSON.parse(rateStr);
          const now = Date.now();
          rateArr.push(now);
          rateArr = rateArr.filter(ts => now - ts < 5000);
          if (rateArr.length > 5) {
             await putCacheAndKV(`flood_banned_${userId}`, 'true', { expirationTtl: 600 });
             await deleteCacheAndKV(`rate_${userId}`);
             await tgReq('sendMessage', { chat_id: userId, text: '⚠️ 发送过于频繁，为防止刷屏，您已被系统暂时禁言 10 分钟。' });
             for (const admin of ADMIN_IDS) {
                 ctx.waitUntil(tgReq('sendMessage', { chat_id: admin, text: `🚨 **刷屏限流报警**\n\n访客 👤 **${display}** (\`${userId}\`) 发送频率过高 (5秒内>5条)，已被系统自动冻结禁言 10 分钟。`, parse_mode: 'Markdown' }));
             }
             return new Response('OK');
          }
          ctx.waitUntil(putCacheAndKV(`rate_${userId}`, JSON.stringify(rateArr), { expirationTtl: 60 }));

          // ------------------------------------------
          // 🛡️ 立体安检扫描 (全面拦截高难度伪装广告)
          // ------------------------------------------
          let rawContent = msg.text || msg.caption || '';
          
          // A. 扫描转发源
          if (msg.forward_from_chat?.title) rawContent += ' ' + msg.forward_from_chat.title;
          if (msg.forward_from_chat?.username) rawContent += ' ' + msg.forward_from_chat.username;
          if (msg.forward_from?.first_name) rawContent += ' ' + msg.forward_from.first_name;
          if (msg.forward_sender_name) rawContent += ' ' + msg.forward_sender_name;

          // B. 扫描内联按钮文字和超链接 (Feature 2 & 4 进阶)
          if (msg.reply_markup?.inline_keyboard) {
             for (const row of msg.reply_markup.inline_keyboard) {
                for (const btn of row) {
                   if (btn.text) rawContent += ' ' + btn.text;
                   if (btn.url) rawContent += ' ' + btn.url;
                }
             }
          }

          // C. 注入发送人姓名 (防昵称广告)
          if (userName) rawContent += ' ' + userName;

          // Feature 1: 文本变异归一处理
          const isMutantOn = await getCacheOrKV('sys_mutantfilter') === 'on';
          const safeCheckContent = isMutantOn ? normalizeText(rawContent) : rawContent.toLowerCase();

          // Feature 6: 小语种与特殊字符隔离
          const isLangShieldOn = await getCacheOrKV('sys_langshield') === 'on';
          if (isLangShieldOn) {
             const cyrillicPattern = /[\u0400-\u04FF]/; // 俄语/西里尔
             const arabicPattern = /[\u0600-\u06FF]/;   // 阿拉伯语
             if (cyrillicPattern.test(userName) || cyrillicPattern.test(rawContent) || arabicPattern.test(userName)) {
                await putCacheAndKV(`banned_${userId}`, 'true');
                ctx.waitUntil(incStat('blocked'));
                ctx.waitUntil(addBlockLog(userId, userName, '小语种物理隔离', `触发名/正文特殊语系: ${rawContent}`));
                return new Response('OK');
             }
          }

          // Feature 2: Telegram 消息实体超链精准拦截
          const isEntityFilterOn = await getCacheOrKV('sys_entityfilter') === 'on';
          if (isEntityFilterOn && (msg.entities || msg.caption_entities)) {
             const ents = msg.entities || msg.caption_entities;
             const linkTypes = ['url', 'text_link', 'mention', 'phone_number'];
             let hasForbiddenEntity = false;
             for (const ent of ents) {
                if (linkTypes.includes(ent.type)) { hasForbiddenEntity = true; break; }
             }
             if (hasForbiddenEntity) {
                await putCacheAndKV(`banned_${userId}`, 'true');
                ctx.waitUntil(incStat('blocked'));
                ctx.waitUntil(addBlockLog(userId, userName, '超链实体黑名单拦截', rawContent));
                return new Response('OK');
             }
          }

          // Feature 4: 智能哈希群控追踪
          const isFingerprintOn = await getCacheOrKV('sys_fingerprint') === 'on';
          const msgHash = await computeHash(rawContent);
          if (isFingerprintOn && rawContent) {
             let spamHashes = JSON.parse(await getCacheOrKV('spam_hashes') || '[]');
             if (spamHashes.includes(msgHash)) {
                await putCacheAndKV(`banned_${userId}`, 'true');
                ctx.waitUntil(incStat('blocked'));
                ctx.waitUntil(addBlockLog(userId, userName, '群控哈希指纹匹配封禁', `哈希匹配: ${msgHash}`));
                return new Response('OK');
             }
          }

          // 核心违禁词匹配（Tier 1 必杀）
          let spamList = JSON.parse(await getCacheOrKV('spam_keywords') || '[]');
          let isSpam = false;
          let matchedWord = "";
          for (const word of spamList) {
             if (safeCheckContent.includes(word.toLowerCase())) { isSpam = true; matchedWord = word; break; }
          }
          
          if (isSpam) {
             await putCacheAndKV(`banned_${userId}`, 'true');
             ctx.waitUntil(incStat('blocked'));
             ctx.waitUntil(addBlockLog(userId, userName, '违禁词封禁', rawContent));
             
             // 捕获指纹录入数据库，秒杀同伙
             if (isFingerprintOn && rawContent) {
                let spamHashes = JSON.parse(await getCacheOrKV('spam_hashes') || '[]');
                spamHashes.unshift(msgHash);
                if (spamHashes.length > 50) spamHashes.pop();
                ctx.waitUntil(putCacheAndKV('spam_hashes', JSON.stringify(spamHashes)));
             }

             const alertOn = await getCacheOrKV('sys_spamalert') !== 'off';
             if (alertOn) {
                 const quickUnban = { inline_keyboard: [[{ text: '✅ 特赦解封加白名单', callback_data: `unban_${userId}` }]] };
                 for (const admin of ADMIN_IDS) {
                    ctx.waitUntil(tgReq('sendMessage', { 
                      chat_id: admin, 
                      text: `🛡️ **静默拦截通知**\n\n已自动拉黑发广告的访客 👤 **${display}** (\`${userId}\`)。\n\n🎯 **触发违禁词:** \`${matchedWord}\`\n🤖 **生成哈希指纹:** \`${msgHash.substring(0,16)}\`\n\n*(此通知可呼出控制台面板关闭)*`, 
                      parse_mode: 'Markdown', reply_markup: quickUnban 
                    }));
                 }
             }
             return new Response('OK');
          }

          // Feature 10: 多级预警词库检测（Tier 2 报警不拉黑）
          const isMultitierOn = await getCacheOrKV('sys_multitier') === 'on';
          let warningTag = "";
          if (isMultitierOn && rawContent) {
             const warnList = JSON.parse(await getCacheOrKV('warn_keywords') || '[]');
             for (const word of warnList) {
                if (safeCheckContent.includes(word.toLowerCase())) {
                   warningTag = `⚠️ **[二级高危预警词命中: ${word}]**\n\n`;
                   break;
                }
             }
          }

          if (await getCacheOrKV('sys_dnd') === 'on') {
            ctx.waitUntil(tgReq('sendMessage', { chat_id: userId, text: isZh ? '🔕 主人目前正忙/休息中，消息已送达，将稍后回复您。' : '🔕 Owner is away. Message delivered.' }));
          }

          // 🌟 锁定用户的完全控制卡片，支持一键备注、拉黑、删除、发送剧透即焚、查看历史最后5条
          const adminQuickActions = {
            inline_keyboard: [
              [
                { text: '💬 锁定对话', callback_data: `setchat_${userId}` },
                { text: '📝 一键备注', callback_data: `qnote_${userId}` },
                { text: '🚫 强力拉黑', callback_data: `qban_${userId}` }
              ],
              [
                { text: '🔥 剧透即焚', callback_data: `qburn_${userId}` },
                { text: '🕒 历史记录', callback_data: `qhistory_${userId}` },
                { text: '🗑️ 移出列表', callback_data: `qdel_${userId}` }
              ]
            ]
          };

          for (const admin of ADMIN_IDS) {
             if (msg.text) {
               await tgReq('sendMessage', { 
                 chat_id: admin, 
                 text: `${warningTag}💬 **来自 👤 ${display}** (\`${userId}\`)\n\n${msg.text}`, 
                 parse_mode: 'Markdown', reply_markup: adminQuickActions 
               });
             } else {
               await tgReq('sendMessage', { 
                 chat_id: admin, 
                 text: `${warningTag}📎 **来自 👤 ${display}** (\`${userId}\`) 发送了 **${mediaDesc}**：`, 
                 parse_mode: 'Markdown', reply_markup: adminQuickActions 
               });
               await tgReq('forwardMessage', { chat_id: admin, from_chat_id: userId, message_id: msgId });
             }
          }
        } else {
          // 未验证访客
          
          // Feature 5: 图片 AI OCR & QR 二维码静默扫描双重拦截 (Feature 6)
          const isOcrOn = await getCacheOrKV('sys_ocrfilter') === 'on';
          if (isOcrOn && msg.photo) {
             try {
                const fileRes = await tgReq('getFile', { file_id: msg.photo[msg.photo.length - 1].file_id });
                if (fileRes.ok) {
                   const filePath = fileRes.result.file_path;
                   const proxyUrl = `https://${url.hostname}/img?file=${filePath}%26secret=${WEBHOOK_SECRET}`;
                   
                   // A. 抓取 OCR 提取文字
                   const ocrRes = await fetch(`https://api.ocr.space/parse/imageurl?apikey=helloworld&url=${proxyUrl}`);
                   const ocrJson = await ocrRes.json();
                   let imageText = '';
                   if (ocrJson.ParsedResults && ocrJson.ParsedResults[0]) {
                      imageText = ocrJson.ParsedResults[0].ParsedText || '';
                      const safeOcrText = imageText.toLowerCase();
                      let spamList = JSON.parse(await getCacheOrKV('spam_keywords') || '[]');
                      let isImgSpam = false;
                      for (const word of spamList) {
                         if (safeOcrText.includes(word.toLowerCase())) { isImgSpam = true; break; }
                      }
                      if (isImgSpam) {
                         await putCacheAndKV(`banned_${userId}`, 'true');
                         ctx.waitUntil(incStat('blocked'));
                         ctx.waitUntil(addBlockLog(userId, userName, '图片 OCR 违禁词识别封禁', `解析文字: ${imageText}`));
                         return new Response('OK');
                      }
                   }

                   // B. 二维码在线静默扫描识别 (Feature 6)
                   const qrRes = await fetch(`https://api.qrserver.com/v1/read-qr-code/?fileurl=${encodeURIComponent(proxyUrl)}`);
                   const qrJson = await qrRes.json();
                   const qrContent = qrJson[0]?.symbol[0]?.data;
                   if (qrContent) {
                      if (qrContent.includes('t.me/') || qrContent.includes('http://') || qrContent.includes('https://')) {
                         await putCacheAndKV(`banned_${userId}`, 'true');
                         ctx.waitUntil(incStat('blocked'));
                         ctx.waitUntil(addBlockLog(userId, userName, '图片 QR 码违禁引流封禁', `解密二维码: ${qrContent}`));
                         return new Response('OK');
                      }
                   }
                }
             } catch (e) {}
          }

          ctx.waitUntil(incStat('blocked'));
          ctx.waitUntil(addBlockLog(userId, userName, '未验证拦截', msg.text || `[${mediaDesc || '媒体'}]`));

          // 验证码下发阶段
          const customWelcome = await getCacheOrKV('welcome_msg') || (isZh ? '您好！为了防止垃圾信息，请完成简单验证：' : 'Hi! To prevent spam, please verify:');
          
          // Feature 10: 动态检测威胁等级自适应难度
          const threatLevel = await getCacheOrKV('sys_threat') || 'normal';
          
          let blockLogs = JSON.parse(await getCacheOrKV('log_blocks') || '[]');
          if (blockLogs.length >= 5) {
             await putCacheAndKV('sys_threat', 'high', { expirationTtl: 600 });
          } else {
             await putCacheAndKV('sys_threat', 'normal');
          }

          let qText = '';
          let correctAns = '';
          let wrong1 = '';
          let wrong2 = '';

          if (threatLevel === 'high') {
             const a = Math.floor(Math.random() * 50) + 10;
             const b = Math.floor(Math.random() * 30) + 5;
             correctAns = (a + b).toString();
             wrong1 = (a + b + 5).toString();
             wrong2 = (a + b - 3).toString();
             qText = `🚨 **正在遭受高频黑产群控威胁，防守升级自适应双重算术验证：**\n\n👉 **${a} + ${b} = ?**`;
          } else {
             const types = ['fruit', 'math', 'find'];
             const captchaTypeSetting = await getCacheOrKV('sys_captcha_type') || 'random';
             const cType = captchaTypeSetting === 'random' ? types[Math.floor(Math.random() * types.length)] : captchaTypeSetting;

             if (cType === 'math') {
                const isAdd = Math.random() > 0.5;
                const a = Math.floor(Math.random() * 20) + 1;
                const b = Math.floor(Math.random() * 20) + 1;
                if (isAdd) {
                    correctAns = (a + b).toString();
                    qText = `**${a} + ${b} = ?**`;
                } else {
                    const max = Math.max(a, b) + 5;
                    const min = Math.min(a, b);
                    correctAns = (max - min).toString();
                    qText = `**${max} - ${min} = ?**`;
                }
                wrong1 = (parseInt(correctAns) + Math.floor(Math.random() * 5) + 1).toString();
                wrong2 = (parseInt(correctAns) - Math.floor(Math.random() * 5) - 1).toString();
             } else if (cType === 'find') {
                const emojis = ['🚗', '🍎', '🏠', '🐶', '💻', '⚽', '🎸', '⌚', '✈️', '🚲'];
                const target = emojis[Math.floor(Math.random() * emojis.length)];
                let others = emojis.filter(e => e !== target).sort(() => 0.5 - Math.random());
                correctAns = target;
                wrong1 = others[0];
                wrong2 = others[1];
                qText = `请在下方按钮中选出指定符号：**${target}**`;
             } else {
                const fruitList = ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓'];
                const emojiA = fruitList[Math.floor(Math.random() * fruitList.length)];
                let emojiB = fruitList[Math.floor(Math.random() * fruitList.length)];
                while (emojiA === emojiB) emojiB = fruitList[Math.floor(Math.random() * fruitList.length)];

                const a = Math.floor(Math.random() * 5) + 1;
                const b = Math.floor(Math.random() * 5) + 1;
                correctAns = (a + b).toString();
                wrong1 = (parseInt(correctAns) + Math.floor(Math.random() * 3) + 1).toString();
                wrong2 = (parseInt(correctAns) - Math.floor(Math.random() * 3) - 1).toString();
                if (parseInt(wrong2) <= 0) wrong2 = (parseInt(correctAns) + 4).toString();
                qText = `**${emojiA.repeat(a)} + ${emojiB.repeat(b)} = ?**\n\n*(${isZh ? '💡 提示：请数一数水果的总数' : '💡 Hint: Count the total fruits'})*`;
             }
          }
          
          const options = [
            { text: correctAns, callback_data: 'captcha_pass' },
            { text: wrong1, callback_data: 'captcha_fail' },
            { text: wrong2, callback_data: 'captcha_fail' }
          ].sort(() => Math.random() - 0.5);

          const sentRes = await tgReq('sendMessage', {
            chat_id: userId,
            text: `🤖 **${isZh ? '安全验证' : 'Anti-Spam Captcha'}**\n\n${customWelcome}\n\n${qText}`,
            parse_mode: 'Markdown', reply_to_message_id: msgId,
            reply_markup: { inline_keyboard: [options] }
          });

          // Feature 8: 验证码超时自动清理功能 (120 秒物理删除，防止僵尸死局)
          const isExpireOn = await getCacheOrKV('sys_captchaexpire') === 'on';
          if (isExpireOn && sentRes.ok) {
             const sentMsgId = sentRes.result.message_id;
             ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 120000)).then(async () => {
                const currentStatus = await getCacheOrKV(`user_${userId}`);
                if (currentStatus !== 'verified') {
                   await tgReq('deleteMessage', { chat_id: userId, message_id: sentMsgId });
                   await tgReq('deleteMessage', { chat_id: userId, message_id: msgId });
                }
             }));
          }
        }
      }

      return new Response('OK');
    }

    return new Response('Super Bot is running.');
  }
};
