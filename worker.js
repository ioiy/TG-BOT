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
    // 1. 系统初始化
    // ==========================================
    if (request.method === 'GET' && url.pathname === '/init') {
      const webhookUrl = `https://${url.hostname}/webhook`;
      const res = await tgReq('setWebhook', { url: webhookUrl, secret_token: WEBHOOK_SECRET });

      await tgReq('setMyCommands', {
        commands: [{ command: 'start', description: '开始使用 / 呼出服务菜单' }],
        scope: { type: 'default' }
      });

      const adminCommands = [
        { command: 'chat', description: '📱 呼出联系人面板锁定单聊' },
        { command: 'end', description: '⏹ 退出锁定单聊模式' },
        { command: 'settings', description: '⚙️ 核心防卫功能控制中心' },
        { command: 'stats', description: '📊 查看系统运行状态数据' },
        { command: 'blocklog', description: '🛡️ 查看详细拦截与错误记录' },
        { command: 'dnd', description: '🔕 开关: 离开/免打扰模式' },
        { command: 'media', description: '🖼️ 开关: 纯文本/媒体拦截' },
        { command: 'kwlist', description: '🤖 查看已设置的自动回复词' },
        { command: 'history', description: '🕒 查看特定用户最近消息 (/history ID)' },
        { command: 'note', description: '📝 设置用户备注 (/note ID 备注)' },
        { command: 'addkw', description: '➕ 添加自动回复 (/addkw 词 回复)' },
        { command: 'delkw', description: '➖ 删除自动回复 (/delkw 词)' },
        { command: 'ban', description: '🚫 永久拉黑用户 (/ban ID)' },
        { command: 'unban', description: '✅ 解除拉黑用户 (/unban ID)' },
        { command: 'addwhite', description: '⚪ 添加白名单 (/addwhite ID)' },
        { command: 'delwhite', description: '⚫ 移除白名单 (/delwhite ID)' },
        { command: 'whitelist', description: '📋 查看白名单列表' },
        { command: 'addwarn', description: '⚠️ 添加预警词 (/addwarn 词)' },
        { command: 'delwarn', description: '❎ 删除预警词 (/delwarn 词)' },
        { command: 'warnlist', description: '📋 查看预警词列表' },
        { command: 'addspam', description: '⛔ 添加违禁词拉黑 (/addspam 词)' },
        { command: 'delspam', description: '❎ 删除违禁词 (/delspam 词)' },
        { command: 'spamlist', description: '📋 查看违禁词表' },
        { command: 'spamalert', description: '🔕 开关: 自动拉黑报警(静默模式)' },
        { command: 'broadcast', description: '📢 全局广播通知 (/broadcast 内容)' },
        { command: 'burn', description: '🔥 阅后即焚消息 (/burn 内容)' }
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

    const incStat = async (key) => {
      let val = await env.KV.get(`stat_${key}`) || 0;
      ctx.waitUntil(env.KV.put(`stat_${key}`, parseInt(val) + 1));
    };

    const addBlockLog = async (uid, name, reason, content) => {
      try {
        let logs = JSON.parse(await env.KV.get('log_blocks') || '[]');
        const d = new Date(Date.now() + 8 * 3600 * 1000);
        const time = `${(d.getUTCMonth()+1).toString().padStart(2,'0')}-${d.getUTCDate().toString().padStart(2,'0')} ${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')}`;
        let safeContent = (content || '').substring(0, 30);
        if (content && content.length > 30) safeContent += '...';
        logs.unshift({ time, id: uid, name, reason, content: safeContent });
        if (logs.length > 20) logs.pop(); 
        ctx.waitUntil(env.KV.put('log_blocks', JSON.stringify(logs)));
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
      const lastId = await env.KV.get(`last_panel_${chatId}`);
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
      if (res.ok) ctx.waitUntil(env.KV.put(`last_panel_${chatId}`, res.result.message_id.toString(), { expirationTtl: 86400 }));
    };

    // 可视化核心控制面板渲染器
    const renderSettingsPanel = async (chatId, msgId = null) => {
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
      const keyboard = [];
      let text = "⚙️ **超级防骚扰功能核心开关面板**\n\n您可以随时点击下方按钮，一键开启或关闭对应的防御模块：\n\n";
      for (const item of keys) {
        const status = await env.KV.get(`sys_${item.key}`) || 'off';
        const icon = status === 'on' ? '🟢 开启' : '🔴 关闭';
        text += `${status === 'on' ? '✅' : '❌'} **${item.name}**: ${status === 'on' ? '已激活' : '已关闭'}\n`;
        keyboard.push([{ text: `${item.name}: ${icon}`, callback_data: `toggle_${item.key}` }]);
      }
      
      if (msgId) {
        await tgReq('editMessageText', {
          chat_id: chatId, message_id: msgId,
          text, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [...keyboard, [{ text: '❌ 关闭面板', callback_data: 'close_panel' }]] }
        });
      } else {
        await sendAdminPanel(chatId, text, { inline_keyboard: keyboard });
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
      // 1. 处理回调查询 (按钮点击)
      // ==========================================
      if (update.callback_query) {
        const cb = update.callback_query;
        const userId = cb.from.id.toString();
        const isAdmin = ADMIN_IDS.includes(userId);
        const userName = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' ') || '未知用户';
        const lang = cb.from.language_code || 'en';
        const isZh = lang.startsWith('zh');

        if (await env.KV.get(`banned_${userId}`)) return new Response('OK');

        if (cb.data === 'close_panel') {
          await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
          return new Response('OK');
        }

        // 核心控制面板 Toggle 交互
        if (cb.data.startsWith('toggle_') && isAdmin) {
          const key = cb.data.replace('toggle_', '');
          const cur = await env.KV.get(`sys_${key}`) || 'off';
          const next = cur === 'on' ? 'off' : 'on';
          await env.KV.put(`sys_${key}`, next);
          await renderSettingsPanel(userId, cb.message.message_id);
          return new Response('OK');
        }

        // --- 访客验证码判断（支持多阶段验证） ---
        if (cb.data === 'captcha_pass') {
          const isNewUserFilterOn = await env.KV.get('sys_newuserfilter') === 'on';
          const isNewUser = parseInt(userId) > 7000000000;
          const stage = await env.KV.get(`captcha_stage_${userId}`);

          if (isNewUserFilterOn && isNewUser && stage !== 'stage2_passed') {
             // 阶段 1 通过，立即下发第二重完全不同的数学题，拉满难度
             await env.KV.put(`captcha_stage_${userId}`, 'stage2_passed', { expirationTtl: 600 });
             const a = Math.floor(Math.random() * 10) + 1;
             const b = Math.floor(Math.random() * 10) + 1;
             const ans = a + b;
             const options = [
               { text: `${ans}`, callback_data: 'captcha_pass' },
               { text: `${ans + 3}`, callback_data: 'captcha_fail' },
               { text: `${ans - 2}`, callback_data: 'captcha_fail' }
             ].sort(() => Math.random() - 0.5);

             await tgReq('editMessageText', {
               chat_id: userId, message_id: cb.message.message_id,
               text: isZh ? `🔒 **[第二阶段安全验证]**\n您已被系统识别为近期新注册账号，为防范脚本炸鱼，请完成最后一道数字验证：\n\n👉 **${a} + ${b} = ?**` : `🔒 **[Stage 2 Verification]**\n\n👉 **${a} + ${b} = ?**`,
               parse_mode: 'Markdown', reply_markup: { inline_keyboard: [options] }
             });
             return new Response('OK');
          }

          // 最终验证通过
          await env.KV.put(`user_${userId}`, 'verified', TTL);
          ctx.waitUntil(env.KV.put(`user_info_${userId}`, userName, TTL));
          ctx.waitUntil(incStat('verified'));
          await env.KV.delete(`captcha_stage_${userId}`);
          
          await tgReq('editMessageText', { 
            chat_id: userId, message_id: cb.message.message_id, 
            text: isZh ? '✅ **验证通过！**\n\n请选择您需要的服务，或直接输入消息发送给人工客服：' : '✅ **Verified!**\n\nPlease select a service or type a message directly:',
            parse_mode: 'Markdown', reply_markup: faqKeyboard
          });
        } else if (cb.data === 'captcha_fail') {
          ctx.waitUntil(incStat('blocked'));
          let fails = parseInt(await env.KV.get(`fails_${userId}`) || '0') + 1;
          await env.KV.put(`fails_${userId}`, fails.toString(), { expirationTtl: 86400 });
          
          // Feature 7: 算术验证防疲劳机制
          const isFatigueOn = await env.KV.get('sys_antifatigue') === 'on';
          if (isFatigueOn && fails >= 2) {
             await env.KV.put(`captcha_cooldown_${userId}`, 'true', { expirationTtl: 3600 }); // 禁言 1 小时
             await tgReq('editMessageText', { 
                chat_id: userId, message_id: cb.message.message_id, 
                text: isZh ? '🚫 **由于您连续输错验证码，系统已被冷冻锁定 1 小时，期间无法再次验证。**' : '🚫 **Cooldown active. Try again in 1 hour.**', 
                parse_mode: 'Markdown' 
             });
             return new Response('OK');
          }

          let maxFails = parseInt(await env.KV.get('sys_maxfails') || '3');
          if (fails >= maxFails) {
            await env.KV.put(`banned_${userId}`, 'true');
            ctx.waitUntil(addBlockLog(userId, userName, '多次验证错误拉黑', `连续失败 ${fails} 次`));
            await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: isZh ? '🚫 **验证失败次数过多，您已被永久拦截。**' : '🚫 **Too many failed attempts. Blocked.**', parse_mode: 'Markdown' });
            
            const alertOn = await env.KV.get('sys_spamalert') !== 'off';
            if (alertOn) {
                for (const admin of ADMIN_IDS) {
                   ctx.waitUntil(tgReq('sendMessage', { chat_id: admin, text: `🛡️ **防刷报警**\n\n访客 👤 **${userName}** (\`${userId}\`) 连续 ${fails} 次验证错误，已被自动拉黑。`, parse_mode: 'Markdown' }));
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
        
        // --- 访客 FAQ 菜单交互 ---
        else if (cb.data.startsWith('faq_')) {
          const action = cb.data.replace('faq_', '');
          if (action === 'menu') {
            await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: '👇 **自助服务菜单**\n请选择您需要了解的内容：', parse_mode: 'Markdown', reply_markup: faqKeyboard });
          } else if (action === '1') {
            const faq1Text = await env.KV.get('faq_1_text') || '💰 **常见问题与价格**\n\n默认文案。管理员请发送 `/setfaq1 内容` 修改。';
            await tgReq('editMessageText', { 
              chat_id: userId, message_id: cb.message.message_id, text: faq1Text, 
              parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 返回菜单', callback_data: 'faq_menu' }]] } 
            });
          } else if (action === '2') {
            const faq2Text = await env.KV.get('faq_2_text') || '📦 **发货与售后说明**\n\n默认文案。管理员请发送 `/setfaq2 内容` 修改。';
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

        // --- 管理员快捷按钮交互 ---
        else if (isAdmin) {
          if (cb.data.startsWith('setchat_')) {
            const targetId = cb.data.replace('setchat_', '');
            await env.KV.put(`active_chat_${userId}`, targetId);
            const targetName = await env.KV.get(`user_info_${targetId}`) || '该用户';
            const note = await env.KV.get(`note_${targetId}`);
            
            await tgReq('editMessageText', {
              chat_id: userId, message_id: cb.message.message_id,
              text: `✅ **已锁定对话**\n\n正在与 👤 **${note ? `${note} (${targetName})` : targetName}** (\`${targetId}\`) 聊天。\n\n退出发 \`/end\`，剧透阅后即焚发 \`/burn 内容\``,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '📝 备注', callback_data: `qnote_${targetId}` },
                    { text: '🚫 拉黑', callback_data: `qban_${targetId}` },
                    { text: '🗑️ 删除', callback_data: `qdel_${targetId}` }
                  ],
                  [{ text: '❌ 关闭面板', callback_data: 'close_panel' }]
                ]
              }
            });
          } else if (cb.data.startsWith('qdel_')) {
            const targetId = cb.data.replace('qdel_', '');
            await env.KV.delete(`user_info_${targetId}`);
            await env.KV.delete(`history_${targetId}`);
            await env.KV.delete(`note_${targetId}`);
            if (await env.KV.get(`active_chat_${userId}`) === targetId) {
                await env.KV.delete(`active_chat_${userId}`);
            }
            await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '🗑️ 成功：已将该访客从列表中移除', show_alert: true });
            await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
          } else if (cb.data.startsWith('qban_')) {
            const targetId = cb.data.replace('qban_', '');
            await env.KV.put(`banned_${targetId}`, 'true');
            await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '🚫 拦截成功：已将该用户永久拉黑', show_alert: true });
            await tgReq('editMessageReplyMarkup', { chat_id: userId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
          } else if (cb.data.startsWith('qnote_')) {
            const targetId = cb.data.replace('qnote_', '');
            await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: `📝 请在输入框发送指令：\n/note ${targetId} 备注`, show_alert: true });
          } else if (cb.data === 'clear_stats') {
            await env.KV.delete('stat_verified');
            await env.KV.delete('stat_blocked');
            await env.KV.delete('stat_msgs');
            await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '🧹 所有统计数据已清零！', show_alert: true });
            await sendAdminPanel(userId, '📊 统计数据已被手动清空。');
          } else if (cb.data === 'bc_confirm') {
            const bcMsgId = await env.KV.get(`pending_bc_${userId}`);
            if (!bcMsgId) return new Response('OK');
            await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: '⏳ 正在拼命群发中，请稍候...' });
            let count = 0;
            for (const k of (await env.KV.list({ prefix: 'user_' })).keys) {
              if (!k.name.startsWith('user_info_')) {
                ctx.waitUntil(tgReq('copyMessage', { chat_id: k.name.replace('user_', ''), from_chat_id: userId, message_id: bcMsgId }));
                count++;
              }
            }
            await env.KV.delete(`pending_bc_${userId}`);
            await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
            await sendAdminPanel(userId, `✅ **广播完成**\n\n已成功将该消息投递给 ${count} 位联系人。`);
          } else if (cb.data === 'bc_cancel') {
            await env.KV.delete(`pending_bc_${userId}`);
            await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
            await sendAdminPanel(userId, '❌ 广播任务已取消。');
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
        const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || '未知用户';

        // ----------------------------------------
        // 【管理员控制台逻辑】
        // ----------------------------------------
        if (isAdmin) {
          const text = (msg.text || msg.caption || '').trim();
          if (text) {
            const cmd = text.split(' ')[0];

            if (text.startsWith('/')) {
               ctx.waitUntil(tgReq('deleteMessage', { chat_id: userId, message_id: msgId }));
            }

            if (cmd === '/chat' || cmd === '/list') {
              const listRes = await env.KV.list({ prefix: 'user_info_' });
              const keyboard = [];
              for (const k of listRes.keys) {
                if (keyboard.length >= 20) break;
                const uid = k.name.replace('user_info_', '');
                if (await env.KV.get(`banned_${uid}`)) continue;
                const uname = await env.KV.get(k.name) || '未知';
                const note = await env.KV.get(`note_${uid}`);
                keyboard.push([{ text: note ? `📝 ${note}` : `👤 ${uname}`, callback_data: `setchat_${uid}` }]);
              }
              await sendAdminPanel(userId, keyboard.length ? '👇 **请选择要对话的联系人：**' : '暂无联系人记录。', { inline_keyboard: keyboard });
              return new Response('OK');
            }
            
            if (cmd === '/end') {
              await env.KV.delete(`active_chat_${userId}`);
              await sendAdminPanel(userId, '⏹ 已退出聊天模式。');
              return new Response('OK');
            }

            if (cmd === '/settings') {
              await renderSettingsPanel(userId);
              return new Response('OK');
            }

            if (cmd === '/stats') {
              const verified = await env.KV.get('stat_verified') || 0;
              const blocked = await env.KV.get('stat_blocked') || 0;
              const msgs = await env.KV.get('stat_msgs') || 0;
              const dnd = await env.KV.get('sys_dnd') === 'on' ? '开启 🟢' : '关闭 🔴';
              const media = await env.KV.get('sys_mediafilter') === 'on' ? '开启 (拦截媒体) 🟢' : '关闭 🔴';
              const statText = `📊 **系统运行统计**\n\n✅ 已验证人数: \`${verified}\`\n🚫 拦截总次数: \`${blocked}\`\n💬 处理消息总数: \`${msgs}\`\n\n🔕 免打扰模式: ${dnd}\n🖼️ 纯文本模式: ${media}\n\n👉 发送 \`/blocklog\` 查看最新详细拦截记录。`;
              await sendAdminPanel(userId, statText, { inline_keyboard: [[{ text: '🧹 清空所有统计数据', callback_data: 'clear_stats' }]] });
              return new Response('OK');
            }

            if (cmd === '/blocklog' || cmd === '/logs') {
              const logsStr = await env.KV.get('log_blocks');
              if (!logsStr || JSON.parse(logsStr).length === 0) {
                await sendAdminPanel(userId, '📭 暂无近期拦截与错误记录。');
                return new Response('OK');
              }
              const reply = JSON.parse(logsStr).map((l, i) => `${i+1}. [${l.time}] 👤 **${l.name}** (\`${l.id}\`)\n   🚫 ${l.reason}: _${l.content}_`).join('\n\n');
              await sendAdminPanel(userId, `🛡️ **近期拦截详情溯源 (最近20条)**\n\n${reply}`);
              return new Response('OK');
            }

            if (cmd === '/dnd') {
              const nextState = await env.KV.get('sys_dnd') === 'on' ? 'off' : 'on';
              await env.KV.put('sys_dnd', nextState);
              await sendAdminPanel(userId, `🔕 免打扰模式已 **${nextState === 'on' ? '开启' : '关闭'}**。`);
              return new Response('OK');
            }

            if (cmd === '/media') {
              const nextState = await env.KV.get('sys_mediafilter') === 'on' ? 'off' : 'on';
              await env.KV.put('sys_mediafilter', nextState);
              await sendAdminPanel(userId, `🖼️ 媒体拦截模式已 **${nextState === 'on' ? '开启' : '关闭'}**。`);
              return new Response('OK');
            }

            if (cmd === '/note') {
              const parts = text.split(' ');
              if (parts.length >= 3) {
                await env.KV.put(`note_${parts[1]}`, parts.slice(2).join(' '));
                await sendAdminPanel(userId, `📝 已将 \`${parts[1]}\` 备注为: **${parts.slice(2).join(' ')}**`);
              }
              return new Response('OK');
            }

            if (cmd === '/history') {
              const targetId = text.split(' ')[1];
              if (targetId) {
                const historyStr = await env.KV.get(`history_${targetId}`) || '[]';
                const reply = JSON.parse(historyStr).length ? JSON.parse(historyStr).map((m, i) => `${i+1}. ${m}`).join('\n') : '暂无文本聊天记录。';
                await sendAdminPanel(userId, `🕒 **最近消息记录**\n\n${reply}`);
              }
              return new Response('OK');
            }

            // 白名单管理指令
            if (cmd === '/addwhite' && text.split(' ')[1]) {
               const tid = text.split(' ')[1];
               let wList = JSON.parse(await env.KV.get('whitelist_users') || '[]');
               if (!wList.includes(tid)) wList.push(tid);
               await env.KV.put('whitelist_users', JSON.stringify(wList));
               await sendAdminPanel(userId, `⚪ 已将用户 \`${tid}\` 添加至白名单。`);
               return new Response('OK');
            }
            if (cmd === '/delwhite' && text.split(' ')[1]) {
               const tid = text.split(' ')[1];
               let wList = JSON.parse(await env.KV.get('whitelist_users') || '[]');
               wList = wList.filter(id => id !== tid);
               await env.KV.put('whitelist_users', JSON.stringify(wList));
               await sendAdminPanel(userId, `⚫ 已将用户 \`${tid}\` 从白名单中移除。`);
               return new Response('OK');
            }
            if (cmd === '/whitelist') {
               const wList = JSON.parse(await env.KV.get('whitelist_users') || '[]');
               await sendAdminPanel(userId, `📋 **白名单用户列表:**\n\n${wList.length ? wList.map(id => `- \`${id}\``).join('\n') : '暂无'}`);
               return new Response('OK');
            }

            // 多级词库管理指令 (预警词 Tier 2)
            if (cmd === '/addwarn' && text.split(' ').length >= 2) {
               const word = text.split(' ').slice(1).join(' ');
               let warnList = JSON.parse(await env.KV.get('warn_keywords') || '[]');
               if (!warnList.includes(word)) warnList.push(word);
               await env.KV.put('warn_keywords', JSON.stringify(warnList));
               await sendAdminPanel(userId, `⚠️ 已将 "**${word}**" 设为**二级预警词**。\n(匹配到时系统不拉黑，但会在转发时发出黄色⚠️警告)`);
               return new Response('OK');
            }
            if (cmd === '/delwarn' && text.split(' ').length >= 2) {
               const word = text.split(' ').slice(1).join(' ');
               let warnList = JSON.parse(await env.KV.get('warn_keywords') || '[]');
               warnList = warnList.filter(w => w !== word);
               await env.KV.put('warn_keywords', JSON.stringify(warnList));
               await sendAdminPanel(userId, `❎ 已删除二级预警词 "**${word}**"`);
               return new Response('OK');
            }
            if (cmd === '/warnlist') {
               const warnList = JSON.parse(await env.KV.get('warn_keywords') || '[]');
               await sendAdminPanel(userId, `📋 **二级预警词列表:**\n\n${warnList.length ? warnList.map(w => `- ${w}`).join('\n') : '无'}`);
               return new Response('OK');
            }

            if (cmd === '/addkw' || cmd === '/delkw' || cmd === '/kwlist') {
              let kwMap = JSON.parse(await env.KV.get('auto_keywords') || '{}');
              if (cmd === '/addkw' && text.split(' ').length >= 3) {
                kwMap[text.split(' ')[1]] = text.split(' ').slice(2).join(' ');
                await env.KV.put('auto_keywords', JSON.stringify(kwMap));
                await sendAdminPanel(userId, `🤖 添加成功！将自动回复包含 "${text.split(' ')[1]}" 的消息。`);
              } else if (cmd === '/delkw' && text.split(' ')[1]) {
                delete kwMap[text.split(' ')[1]];
                await env.KV.put('auto_keywords', JSON.stringify(kwMap));
                await sendAdminPanel(userId, `🗑️ 已删除关键词 "${text.split(' ')[1]}"。`);
              } else if (cmd === '/kwlist') {
                const reply = Object.keys(kwMap).length ? Object.keys(kwMap).map(k => `- ${k}: ${kwMap[k]}`).join('\n') : '无';
                await sendAdminPanel(userId, `🤖 **自动回复关键词表:**\n${reply}`);
              }
              return new Response('OK');
            }

            if (cmd === '/addspam' || cmd === '/delspam' || cmd === '/spamlist') {
              let spamList = JSON.parse(await env.KV.get('spam_keywords') || '[]');
              if (cmd === '/addspam' && text.split(' ').length >= 2) {
                const word = text.split(' ').slice(1).join(' ');
                if (!spamList.includes(word)) spamList.push(word);
                await env.KV.put('spam_keywords', JSON.stringify(spamList));
                await sendAdminPanel(userId, `⛔ 添加违禁词成功！包含 "**${word}**" 的消息将自动被拦截并永久拉黑发送者。`);
              } else if (cmd === '/delspam' && text.split(' ').length >= 2) {
                const word = text.split(' ').slice(1).join(' ');
                spamList = spamList.filter(w => w !== word);
                await env.KV.put('spam_keywords', JSON.stringify(spamList));
                await sendAdminPanel(userId, `❎ 已删除违禁词 "**${word}**"。`);
              } else if (cmd === '/spamlist') {
                const reply = spamList.length ? spamList.map(w => `- ${w}`).join('\n') : '无';
                await sendAdminPanel(userId, `📋 **当前违禁词列表:**\n${reply}`);
              }
              return new Response('OK');
            }

            if (cmd === '/spamalert') {
              const nextState = await env.KV.get('sys_spamalert') === 'off' ? 'on' : 'off';
              await env.KV.put('sys_spamalert', nextState);
              await sendAdminPanel(userId, `🔕 自动拉黑报警已 **${nextState === 'on' ? '开启' : '关闭 (静默模式)'}**。\n\n关闭后，系统自动拉黑（违禁词/验证码多次错误）将不再发消息打扰你，只会悄悄记录到 \`/blocklog\` 中。`);
              return new Response('OK');
            }

            if (cmd === '/ban' || cmd === '/unban' || cmd === '/unverify') {
              const tid = text.split(' ')[1];
              if (tid) {
                if (cmd === '/ban') { await env.KV.put(`banned_${tid}`, 'true'); await sendAdminPanel(userId, `🚫 已永久拉黑 ${tid}`); }
                if (cmd === '/unban') { await env.KV.delete(`banned_${tid}`); await sendAdminPanel(userId, `✅ 已解除拉黑 ${tid}`); }
                if (cmd === '/unverify') { await env.KV.delete(`user_${tid}`); await sendAdminPanel(userId, `🧹 已清除 ${tid} 的验证状态`); }
              }
              return new Response('OK');
            }

            if (cmd === '/deluser') {
              const tid = text.split(' ')[1];
              if (tid) {
                await env.KV.delete(`user_info_${tid}`);
                await env.KV.delete(`history_${tid}`);
                await env.KV.delete(`note_${tid}`);
                await sendAdminPanel(userId, `🗑️ 已将用户 \`${tid}\` 的记录从联系人面板中抹除。`);
              }
              return new Response('OK');
            }

            if (cmd === '/clearlist') {
              const listRes = await env.KV.list({ prefix: 'user_info_' });
              let count = 0;
              for (const k of listRes.keys) {
                 ctx.waitUntil(env.KV.delete(k.name));
                 count++;
              }
              await sendAdminPanel(userId, `🧹 联系人列表已清空 (共清除 ${count} 条记录)。`);
              return new Response('OK');
            }

            if (cmd === '/setwelcome') {
              const w = text.substring(12).trim();
              if (w) { await env.KV.put('welcome_msg', w); await sendAdminPanel(userId, `✅ 欢迎语已更新`); }
              return new Response('OK');
            }

            if (cmd === '/setfaq1') {
              const w = text.substring(9).trim();
              if (w) { await env.KV.put('faq_1_text', w); await sendAdminPanel(userId, `✅ FAQ1 (常见问题) 内容已更新`); }
              return new Response('OK');
            }

            if (cmd === '/setfaq2') {
              const w = text.substring(9).trim();
              if (w) { await env.KV.put('faq_2_text', w); await sendAdminPanel(userId, `✅ FAQ2 (售后说明) 内容已更新`); }
              return new Response('OK');
            }

            if (cmd === '/setcaptcha') {
              const type = text.split(' ')[1];
              if (['random', 'math', 'find', 'fruit'].includes(type)) {
                await env.KV.put('sys_captcha_type', type);
                await sendAdminPanel(userId, `✅ 验证模式已切换为：**${type}**`);
              } else {
                await sendAdminPanel(userId, `⚠️ 格式错误，请使用: \`/setcaptcha random\``, null);
              }
              return new Response('OK');
            }

            if (cmd === '/setmaxfails') {
              const num = parseInt(text.split(' ')[1]);
              if (!isNaN(num) && num > 0) {
                await env.KV.put('sys_maxfails', num.toString());
                await sendAdminPanel(userId, `✅ 验证容错次数已设为：**${num}** 次\n(访客选错 ${num} 次将自动永久拉黑)`);
              } else {
                await sendAdminPanel(userId, `⚠️ 格式错误，请使用: \`/setmaxfails 3\``, null);
              }
              return new Response('OK');
            }

            if (cmd === '/broadcast') {
              await env.KV.put(`pending_bc_${userId}`, msgId.toString(), { expirationTtl: 600 });
              await sendAdminPanel(userId, `📢 **广播发送确认**\n\n将把你的这条消息原封不动（支持带图/视频）群发给所有人。\n是否确认发送？`, {
                 inline_keyboard: [[{ text: '✅ 确认发送', callback_data: 'bc_confirm' }, { text: '❌ 取消', callback_data: 'bc_cancel' }]]
              });
              return new Response('OK');
            }

            if (cmd === '/burn') {
              const activeChat = await env.KV.get(`active_chat_${userId}`);
              const burnMsg = text.substring(6).trim();
              if (activeChat && burnMsg) {
                await tgReq('sendMessage', { 
                  chat_id: activeChat, 
                  text: `🔥 <b>阅后即焚消息</b>\n\n<tg-spoiler>${burnMsg}</tg-spoiler>\n\n<i>(请手动点击马赛克区域查看内容)</i>`, 
                  parse_mode: 'HTML' 
                });
                await tgReq('sendMessage', { chat_id: userId, text: `🔥 剧透保护消息已发送给对方。` });
              } else {
                 await sendAdminPanel(userId, `⚠️ 请先使用 /chat 锁定用户，再使用 /burn <内容>`);
              }
              return new Response('OK');
            }
          }

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

          const activeChat = await env.KV.get(`active_chat_${userId}`);
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
        const isWhitelistOn = await env.KV.get('sys_whitelist') === 'on';
        if (isWhitelistOn) {
           const wList = JSON.parse(await env.KV.get('whitelist_users') || '[]');
           if (wList.includes(userId)) {
              // 绿通直达管理员
              for (const admin of ADMIN_IDS) {
                 await tgReq('copyMessage', { chat_id: admin, from_chat_id: userId, message_id: msgId });
              }
              return new Response('OK');
           }
        }

        // 1. 黑名单检查
        if (await env.KV.get(`banned_${userId}`)) {
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
        
        const mediaFilterOn = await env.KV.get('sys_mediafilter') === 'on';
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
        const isVerified = await env.KV.get(`user_${userId}`);
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
          if (await env.KV.get(`flood_banned_${userId}`)) return new Response('OK');

          ctx.waitUntil(env.KV.put(`user_info_${userId}`, userName, TTL)); // 刷新活跃度
          const note = await env.KV.get(`note_${userId}`);
          const display = note ? `${note} (原名: ${userName})` : userName;

          // 频率判定
          let rateStr = await env.KV.get(`rate_${userId}`) || '[]';
          let rateArr = JSON.parse(rateStr);
          const now = Date.now();
          rateArr.push(now);
          rateArr = rateArr.filter(ts => now - ts < 5000);
          if (rateArr.length > 5) {
             await env.KV.put(`flood_banned_${userId}`, 'true', { expirationTtl: 600 });
             await env.KV.delete(`rate_${userId}`);
             await tgReq('sendMessage', { chat_id: userId, text: '⚠️ 发送过于频繁，为防止刷屏，您已被系统暂时禁言 10 分钟。' });
             for (const admin of ADMIN_IDS) {
                 ctx.waitUntil(tgReq('sendMessage', { chat_id: admin, text: `🚨 **刷屏限流报警**\n\n访客 👤 **${display}** (\`${userId}\`) 发送频率过高 (5秒内>5条)，已被系统自动冻结禁言 10 分钟。`, parse_mode: 'Markdown' }));
             }
             return new Response('OK');
          }
          ctx.waitUntil(env.KV.put(`rate_${userId}`, JSON.stringify(rateArr), { expirationTtl: 60 }));

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
          const isMutantOn = await env.KV.get('sys_mutantfilter') === 'on';
          const safeCheckContent = isMutantOn ? normalizeText(rawContent) : rawContent.toLowerCase();

          // Feature 6: 小语种与特殊字符隔离
          const isLangShieldOn = await env.KV.get('sys_langshield') === 'on';
          if (isLangShieldOn) {
             const cyrillicPattern = /[\u0400-\u04FF]/; // 俄语/西里尔
             const arabicPattern = /[\u0600-\u06FF]/;   // 阿拉伯语
             if (cyrillicPattern.test(userName) || cyrillicPattern.test(rawContent) || arabicPattern.test(userName)) {
                await env.KV.put(`banned_${userId}`, 'true');
                ctx.waitUntil(incStat('blocked'));
                ctx.waitUntil(addBlockLog(userId, userName, '小语种物理隔离', `触发名/正文特殊语系: ${rawContent}`));
                return new Response('OK');
             }
          }

          // Feature 2: Telegram 消息实体超链精准拦截
          const isEntityFilterOn = await env.KV.get('sys_entityfilter') === 'on';
          if (isEntityFilterOn && (msg.entities || msg.caption_entities)) {
             const ents = msg.entities || msg.caption_entities;
             const linkTypes = ['url', 'text_link', 'mention', 'phone_number'];
             let hasForbiddenEntity = false;
             for (const ent of ents) {
                if (linkTypes.includes(ent.type)) { hasForbiddenEntity = true; break; }
             }
             if (hasForbiddenEntity) {
                await env.KV.put(`banned_${userId}`, 'true');
                ctx.waitUntil(incStat('blocked'));
                ctx.waitUntil(addBlockLog(userId, userName, '超链实体黑名单拦截', rawContent));
                return new Response('OK');
             }
          }

          // Feature 4: 智能哈希群控追踪
          const isFingerprintOn = await env.KV.get('sys_fingerprint') === 'on';
          const msgHash = await computeHash(rawContent);
          if (isFingerprintOn && rawContent) {
             let spamHashes = JSON.parse(await env.KV.get('spam_hashes') || '[]');
             if (spamHashes.includes(msgHash)) {
                await env.KV.put(`banned_${userId}`, 'true');
                ctx.waitUntil(incStat('blocked'));
                ctx.waitUntil(addBlockLog(userId, userName, '群控哈希指纹匹配封禁', `哈希匹配: ${msgHash}`));
                return new Response('OK');
             }
          }

          // 核心违禁词匹配（Tier 1 必杀）
          let spamList = JSON.parse(await env.KV.get('spam_keywords') || '[]');
          let isSpam = false;
          let matchedWord = "";
          for (const word of spamList) {
             if (safeCheckContent.includes(word.toLowerCase())) { isSpam = true; matchedWord = word; break; }
          }
          
          if (isSpam) {
             await env.KV.put(`banned_${userId}`, 'true');
             ctx.waitUntil(incStat('blocked'));
             ctx.waitUntil(addBlockLog(userId, userName, '违禁词封禁', rawContent));
             
             // 捕获指纹录入数据库，秒杀同伙
             if (isFingerprintOn && rawContent) {
                let spamHashes = JSON.parse(await env.KV.get('spam_hashes') || '[]');
                spamHashes.unshift(msgHash);
                if (spamHashes.length > 50) spamHashes.pop();
                ctx.waitUntil(env.KV.put('spam_hashes', JSON.stringify(spamHashes)));
             }

             const alertOn = await env.KV.get('sys_spamalert') !== 'off';
             if (alertOn) {
                 for (const admin of ADMIN_IDS) {
                    ctx.waitUntil(tgReq('sendMessage', { 
                      chat_id: admin, 
                      text: `🛡️ **静默拦截通知**\n\n已自动拉黑发广告的访客 👤 **${display}** (\`${userId}\`)。\n\n🎯 **触发违禁词:** \`${matchedWord}\`\n🤖 **生成哈希指纹:** \`${msgHash.substring(0,16)}\`\n\n*(此通知可发 /spamalert 关闭)*`, 
                      parse_mode: 'Markdown' 
                    }));
                 }
             }
             return new Response('OK');
          }

          // Feature 10: 多级预警词库检测（Tier 2 报警不拉黑）
          const isMultitierOn = await env.KV.get('sys_multitier') === 'on';
          let warningTag = "";
          if (isMultitierOn && rawContent) {
             const warnList = JSON.parse(await env.KV.get('warn_keywords') || '[]');
             for (const word of warnList) {
                if (safeCheckContent.includes(word.toLowerCase())) {
                   warningTag = `⚠️ **[二级高危预警词命中: ${word}]**\n\n`;
                   break;
                }
             }
          }

          if (await env.KV.get('sys_dnd') === 'on') {
            ctx.waitUntil(tgReq('sendMessage', { chat_id: userId, text: isZh ? '🔕 主人目前正忙/休息中，消息已送达，将稍后回复您。' : '🔕 Owner is away. Message delivered.' }));
          }

          const adminQuickActions = {
            inline_keyboard: [[
              { text: '💬 回复', callback_data: `setchat_${userId}` },
              { text: '📝 备注', callback_data: `qnote_${userId}` },
              { text: '🚫 拉黑', callback_data: `qban_${userId}` }
            ]]
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
          
          // Feature 5: 图片 AI OCR 功能拦截
          const isOcrOn = await env.KV.get('sys_ocrfilter') === 'on';
          if (isOcrOn && msg.photo) {
             try {
                const fileRes = await tgReq('getFile', { file_id: msg.photo[msg.photo.length - 1].file_id });
                if (fileRes.ok) {
                   const filePath = fileRes.result.file_path;
                   // 代理图片，并发起高精 OCR 扫描
                   const proxyUrl = `https://${url.hostname}/img?file=${filePath}%26secret=${WEBHOOK_SECRET}`;
                   const ocrRes = await fetch(`https://api.ocr.space/parse/imageurl?apikey=helloworld&url=${proxyUrl}`);
                   const ocrJson = await ocrRes.json();
                   if (ocrJson.ParsedResults && ocrJson.ParsedResults[0]) {
                      const imageText = ocrJson.ParsedResults[0].ParsedText || '';
                      
                      // 将解析出的文字丢进安检机
                      const safeOcrText = imageText.toLowerCase();
                      let spamList = JSON.parse(await env.KV.get('spam_keywords') || '[]');
                      let isImgSpam = false;
                      let matchedWord = "";
                      for (const word of spamList) {
                         if (safeOcrText.includes(word.toLowerCase())) { isImgSpam = true; matchedWord = word; break; }
                      }

                      if (isImgSpam) {
                         await env.KV.put(`banned_${userId}`, 'true');
                         ctx.waitUntil(incStat('blocked'));
                         ctx.waitUntil(addBlockLog(userId, userName, '图片 OCR 识别封禁', `解析文字: ${imageText}`));
                         return new Response('OK');
                      }
                   }
                }
             } catch (e) {}
          }

          ctx.waitUntil(incStat('blocked'));
          ctx.waitUntil(addBlockLog(userId, userName, '未验证拦截', msg.text || `[${mediaDesc || '媒体'}]`));

          // 验证码下发阶段
          const customWelcome = await env.KV.get('welcome_msg') || (isZh ? '您好！为了防止垃圾信息，请完成简单验证：' : 'Hi! To prevent spam, please verify:');
          const captchaTypeSetting = await env.KV.get('sys_captcha_type') || 'random';
          const types = ['fruit', 'math', 'find'];
          const cType = captchaTypeSetting === 'random' ? types[Math.floor(Math.random() * types.length)] : captchaTypeSetting;

          let qText = '';
          let correctAns = '';
          let wrong1 = '';
          let wrong2 = '';

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
             qText = `请在下方按钮中选出：**${target}**`;
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
             
             qText = `**${emojiA.repeat(a)} + ${emojiB.repeat(b)} = ?**\n\n*(${isZh ? '💡 提示：请数一数水果的总数' : '💡 Hint: Count total fruits'})*`;
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
          const isExpireOn = await env.KV.get('sys_captchaexpire') === 'on';
          if (isExpireOn && sentRes.ok) {
             const sentMsgId = sentRes.result.message_id;
             ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 120000)).then(async () => {
                // 如果 120 秒后依然没有通过验证，自动悄悄删除下发的验证码消息和访客原消息
                const currentStatus = await env.KV.get(`user_${userId}`);
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
