-- P1 自检：建表正确性 + 中文全文检索 + 唯一约束 + 清理
-- 用法（--force 让"预期会失败"的语句不打断脚本）：
--   mysql -u chat_app -p --force --default-character-set=utf8mb4 chat_mini < scripts/selfcheck.sql
--
-- 注意：InnoDB 的 FULLTEXT 索引在事务提交时才更新，
-- 所以全文检索的验证必须在 COMMIT 之后做，不能在未提交的事务里搜。

SELECT '--- 0. 清理上次可能残留的测试数据 ---' AS step;
DELETE FROM users WHERE username = 'demo';

SELECT '--- 1. 表清单 ---' AS step;
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'chat_mini' ORDER BY TABLE_NAME;

SELECT '--- 2. 中文注释（应为正常中文）---' AS step;
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'chat_mini'
   AND TABLE_NAME IN ('messages', 'chat_sessions')
   AND COLUMN_COMMENT <> ''
 ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT '--- 3. 写入 ---' AS step;
INSERT INTO users (id, username, display_name, password_hash, created_at)
VALUES ('u-test', 'demo', '示例用户', 'scrypt$65536$8$1$c2FsdA==$aGFzaA==', NOW(3));

INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at)
VALUES ('s-test', 'u-test', '刷新不中断是什么原理', NOW(3), NOW(3));

INSERT INTO messages (id, session_id, seq, role, content, status, created_at, updated_at)
VALUES ('m1', 's-test', 1, 'user', '刷新不中断是什么原理', 'complete', NOW(3), NOW(3)),
       ('m2', 's-test', 2, 'assistant', '生成跑在服务端进程里，不挂在 HTTP 连接上。', 'complete', NOW(3), NOW(3));

SELECT seq, role, CHAR_LENGTH(content) AS chars FROM messages WHERE session_id = 's-test' ORDER BY seq;

SELECT '--- 4. ngram 中文全文检索：搜「服务端」应命中 ---' AS step;
SELECT id, LEFT(content, 20) AS preview
  FROM messages WHERE MATCH(content) AGAINST ('服务端' IN BOOLEAN MODE);

SELECT '--- 5. 排序与级联：删用户应连带删会话和消息 ---' AS step;
SELECT COUNT(*) AS before_delete FROM messages;
DELETE FROM users WHERE id = 'u-test';
SELECT (SELECT COUNT(*) FROM messages) AS messages_after,
       (SELECT COUNT(*) FROM chat_sessions) AS chat_sessions_after,
       (SELECT COUNT(*) FROM users) AS users_after;

SELECT '--- 6. 唯一约束：同会话同 seq 再插一次应报 ERROR 1062 ---' AS step;
INSERT INTO users (id, username, display_name, password_hash, created_at)
VALUES ('u-test2', 'demo2', '', 'x', NOW(3));
INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at)
VALUES ('s-test2', 'u-test2', 't', NOW(3), NOW(3));
INSERT INTO messages (id, session_id, seq, role, content, status, created_at, updated_at)
VALUES ('mm1', 's-test2', 1, 'user', 'a', 'complete', NOW(3), NOW(3));
INSERT INTO messages (id, session_id, seq, role, content, status, created_at, updated_at)
VALUES ('mm2', 's-test2', 1, 'user', 'b', 'complete', NOW(3), NOW(3));

SELECT '--- 7. 清理 + 最终状态（都应为 0）---' AS step;
DELETE FROM users WHERE username IN ('demo', 'demo2');
SELECT (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM chat_sessions) AS chat_sessions,
       (SELECT COUNT(*) FROM messages) AS messages,
       (SELECT COUNT(*) FROM auth_sessions) AS auth_sessions,
       (SELECT COUNT(*) FROM runs) AS runs;
