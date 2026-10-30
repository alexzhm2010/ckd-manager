/* ============================================================
   云端存储配置（Supabase）
   ------------------------------------------------------------
   应用只有邮箱登录一种方式，所以这里必须填好才能使用：
   1) 打开 https://supabase.com 新建一个免费项目（Project）。
   2) 打开项目 → SQL Editor，把 supabase/schema.sql 全文粘贴进去执行。
   3) 打开 Project Settings → API，复制两个值填到下面：
        url     = Project URL（形如 https://xxxx.supabase.co）
      anonKey   = anon public key（eyJ... 开头的长串）
   4) 建议在 Authentication → Providers → Email 里关闭「Confirm email」，
      否则注册后要先点邮件里的确认链接。

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
