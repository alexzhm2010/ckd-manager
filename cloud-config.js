/* ============================================================
   云端存储配置（Supabase）
   ------------------------------------------------------------
   不填也没关系：留空时应用完整运行在「本地模式」，数据只存在本机浏览器。
   要开启跨设备持久化，按下面三步做（全程约 5 分钟）：

   1) 打开 https://supabase.com 新建一个免费项目（Project）。
   2) 打开项目 → SQL Editor，把 supabase/schema.sql 全文粘贴进去执行。
   3) 打开 Project Settings → API，复制两个值填到下面：
        url     = Project URL（形如 https://xxxx.supabase.co）
      anonKey   = anon public key（eyJ... 开头的长串）

   注意：
   - anonKey 是公开密钥，放在前端没有问题；权限由数据库里的 RLS 策略控制，
     每个账号只能读写自己的数据。
   - 绝对不要把 service_role key 写进前端。
   - 填好后重新发布（push）本仓库，GitHub Pages 会自动更新。
   ============================================================ */
window.CLOUD_CONFIG = {
  url: 'https://puxmntkqoykgnxlgrydj.supabase.co',
  anonKey: 'sb_publishable_vcVYEYYKXrYJhinZKK3XsQ_wdoHbeQU'
};
