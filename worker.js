export default {
  async fetch(request, env, ctx) {
    const BOT_TOKEN = env.BOT_TOKEN;
    const ADMIN_ID_ENV = env.ADMIN_ID;

    if (!BOT_TOKEN || !ADMIN_ID_ENV) {
      return new Response('请先在环境变量中配置 BOT_TOKEN 和 ADMIN_ID', { status: 500 });
    }

    // 支持多管理员：用逗号分隔
    const ADMIN_IDS = ADMIN_ID_ENV.split(',').map(id => id.trim());
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}`;

    // 封装 TG 请求
    const tgReq = async (method, payload) => {
      const res = await fetch(`${apiUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return res.json();
    };

    const url = new URL(request.url);

    // 🚀 一键绑定 Webhook 与自动配置双轨菜单
    if (request.method === 'GET' && url.pathname === '/init') {
      const webhookUrl = `https://${url.hostname}/webhook`;
      const res = await tgReq('setWebhook', { url: webhookUrl });

      // 1. 给普通访客设置基础菜单
      await tgReq('setMyCommands', {
        commands: [{ command: 'start', description: '开始使用 / 重新呼出安全验证' }],
        scope: { type: 'default' }
      });

      // 2. 给管理员设置高级快捷菜单 (全量命令)
      const adminCommands = [
        { command: 'chat', description: '📱 呼出联系人面板锁定单聊' },
        { command: 'end', description: '⏹ 退出锁定单聊模式' },
        { command: 'stats', description: '📊 查看系统运行状态数据' },
        { command: 'dnd', description: '🔕 开关: 离开/免打扰模式' },
        { command: 'media', description: '🖼️ 开关: 纯文本/媒体拦截' },
        { command: 'kwlist', description: '🤖 查看已设置的自动回复词' },
        { command: 'history', description: '🕒 查看特定用户最近消息 (/history ID)' },
        { command: 'note', description: '📝 设置用户备注 (/note ID 备注)' },
        { command: 'addkw', description: '➕ 添加自动回复 (/addkw 词 回复)' },
        { command: 'delkw', description: '➖ 删除自动回复 (/delkw 词)' },
        { command: 'ban', description: '🚫 永久拉黑用户 (/ban ID)' },
        { command: 'unban', description: '✅ 解除拉黑用户 (/unban ID)' },
        { command: 'unverify', description: '🧹 清除验证状态 (/unverify ID)' },
        { command: 'setwelcome', description: '💬 自定义欢迎语 (/setwelcome 内容)' },
        { command: 'broadcast', description: '📢 全局广播通知 (/broadcast 内容)' },
        { command: 'burn', description: '🔥 阅后即焚消息 (/burn 内容)' }
      ];
      
      for (const adminId of ADMIN_IDS) {
        await tgReq('setMyCommands', {
          commands: adminCommands,
          scope: { type: 'chat', chat_id: adminId }
        });
      }

      return new Response(res.ok ? `✅ 初始化成功!\n1. Webhook 绑定成功: ${webhookUrl}\n2. 机器人双轨菜单已更新 (包含了所有进阶指令)` : `❌ 失败: ${JSON.stringify(res)}`);
    }

    // 统计数据累加辅助函数
    const incStat = async (key) => {
      let val = await env.KV.get(`stat_${key}`) || 0;
      ctx.waitUntil(env.KV.put(`stat_${key}`, parseInt(val) + 1));
    };

    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update;
      try { update = await request.json(); } catch (e) { return new Response('Bad Request'); }

      // ==========================================
      // 1. 处理按钮点击 (验证码、联系人选择)
      // ==========================================
      if (update.callback_query) {
        const cb = update.callback_query;
        const userId = cb.from.id.toString();
        const isAdmin = ADMIN_IDS.includes(userId);

        if (await env.KV.get(`banned_${userId}`)) return new Response('OK');

        if (cb.data === 'captcha_pass') {
          await env.KV.put(`user_${userId}`, 'verified');
          const userName = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' ') || '未知用户';
          ctx.waitUntil(env.KV.put(`user_info_${userId}`, userName));
          ctx.waitUntil(incStat('verified'));

          const lang = cb.from.language_code || 'en';
          const text = lang.startsWith('zh') ? '✅ 验证通过！您的消息我将实时转发给主人。' : '✅ Verification passed! You can chat now.';
          
          await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text });
        } else if (cb.data === 'captcha_fail') {
          const lang = cb.from.language_code || 'en';
          await tgReq('answerCallbackQuery', { 
            callback_query_id: cb.id, 
            text: lang.startsWith('zh') ? '❌ 算错了哦，请重试' : '❌ Wrong answer, try again', 
            show_alert: true 
          });
        } else if (cb.data.startsWith('setchat_') && isAdmin) {
          const targetId = cb.data.replace('setchat_', '');
          await env.KV.put(`active_chat_${userId}`, targetId); // 为该管理员独立锁定
          const targetName = await env.KV.get(`user_info_${targetId}`) || '该用户';
          const note = await env.KV.get(`note_${targetId}`);
          const displayName = note ? `${note} (${targetName})` : targetName;
          
          await tgReq('editMessageText', {
            chat_id: userId,
            message_id: cb.message.message_id,
            text: `✅ **已锁定对话**\n\n正在与 👤 **${displayName}** (\`${targetId}\`) 聊天。\n发送 /end 退出。\n发送 /burn <内容> 可阅后即焚。`,
            parse_mode: 'Markdown'
          });
        }
        return new Response('OK');
      }

      // ==========================================
      // 2. 处理普通消息
      // ==========================================
      if (update.message && update.message.chat.type === 'private') {
        const msg = update.message;
        const userId = msg.from.id.toString();
        const msgId = msg.message_id;
        const isAdmin = ADMIN_IDS.includes(userId);

        // ----------------------------------------
        // 【管理员控制台逻辑】
        // ----------------------------------------
        if (isAdmin) {
          if (msg.text) {
            const text = msg.text.trim();
            const cmd = text.split(' ')[0];

            // 联系人列表
            if (cmd === '/chat' || cmd === '/list') {
              const listRes = await env.KV.list({ prefix: 'user_info_' });
              const keys = listRes.keys.slice(0, 20);
              const keyboard = [];
              for (const k of keys) {
                const uid = k.name.replace('user_info_', '');
                const uname = await env.KV.get(k.name) || '未知';
                const note = await env.KV.get(`note_${uid}`);
                const display = note ? `📝 ${note}` : `👤 ${uname}`;
                keyboard.push([{ text: display, callback_data: `setchat_${uid}` }]);
              }
              await tgReq('sendMessage', {
                chat_id: userId,
                text: keyboard.length ? '👇 **请选择要对话的联系人：**' : '暂无联系人记录。',
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
              });
              return new Response('OK');
            }
            
            // 退出锁定
            if (cmd === '/end') {
              await env.KV.delete(`active_chat_${userId}`);
              await tgReq('sendMessage', { chat_id: userId, text: '⏹ 已退出聊天模式。' });
              return new Response('OK');
            }

            // 数据统计面板
            if (cmd === '/stats') {
              const verified = await env.KV.get('stat_verified') || 0;
              const blocked = await env.KV.get('stat_blocked') || 0;
              const msgs = await env.KV.get('stat_msgs') || 0;
              const dnd = await env.KV.get('sys_dnd') === 'on' ? '开启 🟢' : '关闭 🔴';
              const media = await env.KV.get('sys_mediafilter') === 'on' ? '开启 (拦截媒体) 🟢' : '关闭 🔴';
              const text = `📊 **系统运行统计**\n\n✅ 已验证人数: \`${verified}\`\n🚫 拦截垃圾/错误: \`${blocked}\`\n💬 处理消息总数: \`${msgs}\`\n\n🔕 免打扰模式: ${dnd}\n🖼️ 纯文本模式: ${media}`;
              await tgReq('sendMessage', { chat_id: userId, text, parse_mode: 'Markdown' });
              return new Response('OK');
            }

            // 免打扰模式开关
            if (cmd === '/dnd') {
              const current = await env.KV.get('sys_dnd');
              const nextState = current === 'on' ? 'off' : 'on';
              await env.KV.put('sys_dnd', nextState);
              await tgReq('sendMessage', { chat_id: userId, text: `🔕 免打扰模式已 **${nextState === 'on' ? '开启' : '关闭'}**。` });
              return new Response('OK');
            }

            // 媒体拦截开关
            if (cmd === '/media') {
              const current = await env.KV.get('sys_mediafilter');
              const nextState = current === 'on' ? 'off' : 'on';
              await env.KV.put('sys_mediafilter', nextState);
              await tgReq('sendMessage', { chat_id: userId, text: `🖼️ 媒体拦截模式已 **${nextState === 'on' ? '开启' : '关闭'}**。` });
              return new Response('OK');
            }

            // 设置备注
            if (cmd === '/note') {
              const parts = text.split(' ');
              if (parts.length >= 3) {
                const targetId = parts[1];
                const note = parts.slice(2).join(' ');
                await env.KV.put(`note_${targetId}`, note);
                await tgReq('sendMessage', { chat_id: userId, text: `📝 已将 \`${targetId}\` 备注为: **${note}**`, parse_mode: 'Markdown' });
              } else {
                await tgReq('sendMessage', { chat_id: userId, text: `⚠️ 格式错误，请使用: /note 用户ID 备注名` });
              }
              return new Response('OK');
            }

            // 查看历史消息
            if (cmd === '/history') {
              const targetId = text.split(' ')[1];
              if (targetId) {
                const historyStr = await env.KV.get(`history_${targetId}`) || '[]';
                const history = JSON.parse(historyStr);
                const reply = history.length ? history.map((m, i) => `${i+1}. ${m}`).join('\n') : '暂无文本聊天记录。';
                await tgReq('sendMessage', { chat_id: userId, text: `🕒 **最近消息记录**\n\n${reply}`, parse_mode: 'Markdown' });
              } else {
                await tgReq('sendMessage', { chat_id: userId, text: `⚠️ 格式错误，请使用: /history 用户ID` });
              }
              return new Response('OK');
            }

            // 关键词自动回复
            if (cmd === '/addkw') {
              const parts = text.split(' ');
              if (parts.length >= 3) {
                const kw = parts[1];
                const replyText = parts.slice(2).join(' ');
                let kwMap = JSON.parse(await env.KV.get('auto_keywords') || '{}');
                kwMap[kw] = replyText;
                await env.KV.put('auto_keywords', JSON.stringify(kwMap));
                await tgReq('sendMessage', { chat_id: userId, text: `🤖 添加成功！当用户发送包含 "${kw}" 的消息时，将自动回复。` });
              } else {
                await tgReq('sendMessage', { chat_id: userId, text: `⚠️ 格式错误，请使用: /addkw 关键词 回复内容` });
              }
              return new Response('OK');
            }
            if (cmd === '/delkw') {
              const kw = text.split(' ')[1];
              if (kw) {
                let kwMap = JSON.parse(await env.KV.get('auto_keywords') || '{}');
                delete kwMap[kw];
                await env.KV.put('auto_keywords', JSON.stringify(kwMap));
                await tgReq('sendMessage', { chat_id: userId, text: `🗑️ 已删除关键词 "${kw}"。` });
              } else {
                await tgReq('sendMessage', { chat_id: userId, text: `⚠️ 格式错误，请使用: /delkw 关键词` });
              }
              return new Response('OK');
            }
            if (cmd === '/kwlist') {
              let kwMap = JSON.parse(await env.KV.get('auto_keywords') || '{}');
              const keys = Object.keys(kwMap);
              const reply = keys.length ? keys.map(k => `- ${k}: ${kwMap[k]}`).join('\n') : '无';
              await tgReq('sendMessage', { chat_id: userId, text: `🤖 **自动回复关键词表:**\n${reply}`, parse_mode: 'Markdown' });
              return new Response('OK');
            }

            // 基础管理指令
            if (cmd === '/ban') {
              const tid = text.split(' ')[1];
              if (tid) { await env.KV.put(`banned_${tid}`, 'true'); await tgReq('sendMessage', { chat_id: userId, text: `🚫 已永久拉黑 ${tid}` }); }
              return new Response('OK');
            }
            if (cmd === '/unban') {
              const tid = text.split(' ')[1];
              if (tid) { await env.KV.delete(`banned_${tid}`); await tgReq('sendMessage', { chat_id: userId, text: `✅ 已解除拉黑 ${tid}` }); }
              return new Response('OK');
            }
            if (cmd === '/unverify') {
              const tid = text.split(' ')[1];
              if (tid) { await env.KV.delete(`user_${tid}`); await tgReq('sendMessage', { chat_id: userId, text: `🧹 已清除 ${tid} 的验证状态` }); }
              return new Response('OK');
            }
            if (cmd === '/setwelcome') {
              const w = text.substring(12).trim();
              if (w) { await env.KV.put('welcome_msg', w); await tgReq('sendMessage', { chat_id: userId, text: `✅ 欢迎语已更新` }); }
              return new Response('OK');
            }

            // 广播
            if (cmd === '/broadcast') {
              const bMsg = text.substring(11).trim();
              if (!bMsg) return new Response('OK');
              const listRes = await env.KV.list({ prefix: 'user_' });
              let count = 0;
              for (const k of listRes.keys) {
                if (k.name.startsWith('user_info_')) continue;
                const targetId = k.name.replace('user_', '');
                ctx.waitUntil(tgReq('sendMessage', { chat_id: targetId, text: `📢 **全局通知**\n\n${bMsg}`, parse_mode: 'Markdown' }));
                count++;
              }
              await tgReq('sendMessage', { chat_id: userId, text: `✅ 广播任务已提交，预计发送给 ${count} 人。` });
              return new Response('OK');
            }

            // 阅后即焚 (发送后倒计时删除)
            if (cmd === '/burn') {
              const activeChat = await env.KV.get(`active_chat_${userId}`);
              const burnMsg = text.substring(6).trim();
              if (activeChat && burnMsg) {
                const res = await tgReq('sendMessage', { 
                  chat_id: activeChat, 
                  text: `🔥 **[阅后即焚消息]**\n\n${burnMsg}\n\n*(此消息将在 25 秒后自动销毁)*`, 
                  parse_mode: 'Markdown' 
                });
                if (res.ok) {
                  await tgReq('sendMessage', { chat_id: userId, text: `🔥 阅后即焚已发送给 ${activeChat}，25秒后撤回。` });
                  // 等待 25 秒后双向撤回 (利用 ctx.waitUntil 防止 Worker 休眠)
                  ctx.waitUntil(new Promise(r => setTimeout(r, 25000)).then(() => {
                    tgReq('deleteMessage', { chat_id: activeChat, message_id: res.result.message_id });
                  }));
                }
              } else {
                 await tgReq('sendMessage', { chat_id: userId, text: `⚠️ 请先使用 /chat 锁定用户，再使用 /burn <内容>` });
              }
              return new Response('OK');
            }
          }

          // 手动回复访客
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

          // 锁定聊天发送
          const activeChat = await env.KV.get(`active_chat_${userId}`);
          if (activeChat) {
            await tgReq('copyMessage', { chat_id: activeChat, from_chat_id: userId, message_id: msgId });
          } else if (!msg.text?.startsWith('/')) {
            await tgReq('sendMessage', { chat_id: userId, text: 'ℹ️ **操作提示**\n当前未锁定聊天对象。请发送 `/chat`，或左滑回复用户消息。', parse_mode: 'Markdown' });
          }
          return new Response('OK');
        }

        // ----------------------------------------
        // 【普通访客逻辑】
        // ----------------------------------------
        ctx.waitUntil(incStat('msgs')); // 统计总消息

        // 1. 黑名单检查
        if (await env.KV.get(`banned_${userId}`)) return new Response('OK');

        // 2. 媒体拦截检查
        const mediaFilterOn = await env.KV.get('sys_mediafilter') === 'on';
        if (mediaFilterOn && !msg.text) {
           const lang = msg.from.language_code || 'en';
           await tgReq('sendMessage', { 
             chat_id: userId, 
             text: lang.startsWith('zh') ? '⚠️ 主人已开启纯文本模式，无法接收图片、视频或文件。' : '⚠️ Owner only accepts text messages currently.',
             reply_to_message_id: msgId 
           });
           return new Response('OK');
        }

        // 3. 验证检查
        const isVerified = await env.KV.get(`user_${userId}`);
        const lang = msg.from.language_code || 'en';
        const isZh = lang.startsWith('zh');

        // 拦截访客的 /start 命令，避免干扰管理员
        if (msg.text === '/start') {
           if (isVerified === 'verified') {
             await tgReq('sendMessage', { chat_id: userId, text: isZh ? '✅ 您已通过验证，可以直接发送消息。' : '✅ Verified. You can send messages directly.' });
             return new Response('OK');
           }
           // 若未验证，则顺延到下方的生成算术题逻辑
        }

        if (isVerified === 'verified') {
          // 记录基础信息
          const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || '未知用户';
          ctx.waitUntil(env.KV.put(`user_info_${userId}`, userName));
          
          const note = await env.KV.get(`note_${userId}`);
          const display = note ? `${note} (原名: ${userName})` : userName;

          // 记录历史文本 (仅保存最后 5 条)
          if (msg.text) {
             let historyStr = await env.KV.get(`history_${userId}`) || '[]';
             let history = JSON.parse(historyStr);
             history.push(msg.text.substring(0, 100)); // 限制长度
             if (history.length > 5) history.shift();
             ctx.waitUntil(env.KV.put(`history_${userId}`, JSON.stringify(history)));

             // 关键词自动回复匹配
             let kwMap = JSON.parse(await env.KV.get('auto_keywords') || '{}');
             for (const kw in kwMap) {
                if (msg.text.includes(kw)) {
                  ctx.waitUntil(tgReq('sendMessage', { chat_id: userId, text: kwMap[kw], reply_to_message_id: msgId }));
                  break; // 只匹配第一个
                }
             }
          }

          // DND 模式提示
          const dndOn = await env.KV.get('sys_dnd') === 'on';
          if (dndOn) {
            ctx.waitUntil(tgReq('sendMessage', { 
              chat_id: userId, 
              text: isZh ? '🔕 主人目前正忙/休息中，消息已送达，将稍后回复您。' : '🔕 Owner is away. Message delivered.',
            }));
          }

          // 遍历转发给所有管理员
          for (const admin of ADMIN_IDS) {
             if (msg.text) {
               await tgReq('sendMessage', { chat_id: admin, text: `💬 **来自 👤 ${display}** (\`${userId}\`)\n\n${msg.text}`, parse_mode: 'Markdown' });
             } else {
               await tgReq('sendMessage', { chat_id: admin, text: `📎 **来自 👤 ${display}** (\`${userId}\`) 发送了媒体：`, parse_mode: 'Markdown' });
               await tgReq('forwardMessage', { chat_id: admin, from_chat_id: userId, message_id: msgId });
             }
          }

        } else {
          // ==============================
          // 未验证：智能多语言 Emoji 验证码
          // ==============================
          ctx.waitUntil(incStat('blocked'));
          const customWelcome = await env.KV.get('welcome_msg') || (isZh ? '您好！为了防止垃圾信息，请完成简单验证：' : 'Hi! To prevent spam, please verify:');
          
          // 生成直观的 Emoji 计数算术题
          const fruitList = ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓'];
          const emojiA = fruitList[Math.floor(Math.random() * fruitList.length)];
          let emojiB = fruitList[Math.floor(Math.random() * fruitList.length)];
          while (emojiA === emojiB) emojiB = fruitList[Math.floor(Math.random() * fruitList.length)];

          const a = Math.floor(Math.random() * 5) + 1; // 1-5
          const b = Math.floor(Math.random() * 5) + 1; // 1-5
          const correctAns = a + b;
          
          const strA = emojiA.repeat(a);
          const strB = emojiB.repeat(b);
          
          // 生成干扰项 (保证不重复)
          let wrong1 = correctAns + Math.floor(Math.random() * 3) + 1;
          let wrong2 = correctAns - Math.floor(Math.random() * 3) - 1;
          if (wrong2 <= 0) wrong2 = correctAns + 4;
          
          const options = [
            { text: `${correctAns}`, callback_data: 'captcha_pass' },
            { text: `${wrong1}`, callback_data: 'captcha_fail' },
            { text: `${wrong2}`, callback_data: 'captcha_fail' }
          ].sort(() => Math.random() - 0.5);

          await tgReq('sendMessage', {
            chat_id: userId,
            text: `🤖 **${isZh ? '安全验证' : 'Anti-Spam Captcha'}**\n\n${customWelcome}\n\n**${strA} + ${strB} = ?**\n\n*(${isZh ? '💡 提示：请数一数水果的总数' : '💡 Hint: Count the total fruits'})*`,
            parse_mode: 'Markdown',
            reply_to_message_id: msgId,
            reply_markup: { inline_keyboard: [options] }
          });
        }
      }

      return new Response('OK');
    }

    return new Response('Super Bot is running.');
  }
};
