-- 收紧应用账号权限：只给 CRUD，不给 DDL
--
-- docker-entrypoint 先用 MYSQL_USER / MYSQL_PASSWORD 建出 chat_app 并 GRANT ALL，
-- 这里把 DDL 收回去，和 scripts/schema.sql 开头的约定保持一致：
-- 建表由 root 在首次启动时跑 01-schema.sql 完成，应用永远没有改表结构的权限。
--
-- ⚠️ 如果你在 .env 里把 DB_NAME 改成了别的名字，这个文件里的 chat_mini 也要跟着改。

REVOKE ALL PRIVILEGES ON `chat_mini`.* FROM 'chat_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `chat_mini`.* TO 'chat_app'@'%';
FLUSH PRIVILEGES;
