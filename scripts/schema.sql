-- chat-mini 数据表结构
-- 应用账号 chat_app 只有 CRUD 权限，DDL 由部署者用 root 执行本文件：
--   mysql -u root -p --default-character-set=utf8mb4 chat_mini < scripts/schema.sql
-- 本文件可重复执行（全部 IF NOT EXISTS）。
--
-- 命名约定：
--   chat_sessions = 聊天会话（一个对话框）
--   auth_sessions = 登录会话（一次登录 = 一行 = 一个 cookie）
--   时间统一 DATETIME(3)（毫秒精度，前端用 Date.now() 直接对得上）

SET NAMES utf8mb4;

-- ---------------------------------------------------------------- 用户
CREATE TABLE IF NOT EXISTS users (
  id            CHAR(36)     NOT NULL,
  username      VARCHAR(32)  NOT NULL COMMENT '登录名，存小写',
  display_name  VARCHAR(64)  NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL COMMENT 'scrypt$N$r$p$salt$hash',
  created_at    DATETIME(3)  NOT NULL,
  last_login_at DATETIME(3)  NULL,
  disabled      TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------- 登录会话
CREATE TABLE IF NOT EXISTS auth_sessions (
  id           CHAR(36)     NOT NULL,
  user_id      CHAR(36)     NOT NULL,
  token_hash   CHAR(64)     NOT NULL COMMENT 'sha256(cookie 里的原始 token)，库里不存明文 token',
  created_at   DATETIME(3)  NOT NULL,
  expires_at   DATETIME(3)  NOT NULL,
  last_seen_at DATETIME(3)  NOT NULL,
  user_agent   VARCHAR(255) NOT NULL DEFAULT '',
  ip           VARCHAR(45)  NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uk_auth_token (token_hash),
  KEY idx_auth_user (user_id, expires_at),
  CONSTRAINT fk_auth_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------- 聊天会话
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         CHAR(36)     NOT NULL,
  user_id    CHAR(36)     NOT NULL,
  title      VARCHAR(120) NOT NULL DEFAULT '新对话',
  created_at DATETIME(3)  NOT NULL,
  updated_at DATETIME(3)  NOT NULL,
  deleted_at DATETIME(3)  NULL COMMENT '软删除：误删可救，也不连带删消息',
  PRIMARY KEY (id),
  KEY idx_chat_list (user_id, deleted_at, updated_at DESC),
  CONSTRAINT fk_chat_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------- 消息
-- seq 是会话内顺序号（1,2,3…）。排序只用它，不用 created_at：
-- 同一毫秒写入的两条消息，时间戳拉不开顺序，序号可以。
CREATE TABLE IF NOT EXISTS messages (
  id                CHAR(36)     NOT NULL,
  session_id        CHAR(36)     NOT NULL,
  seq               INT          NOT NULL,
  role              ENUM('user','assistant','system') NOT NULL,
  content           MEDIUMTEXT   NOT NULL COMMENT 'MEDIUMTEXT 而不是 TEXT：TEXT 上限 64KB，utf8mb4 下只有 ~1.6 万字符',
  thinking          MEDIUMTEXT   NULL,
  prompt_tokens     INT          NULL,
  completion_tokens INT          NULL,
  status            ENUM('streaming','complete','interrupted','stopped','error') NOT NULL DEFAULT 'complete',
  error_text        VARCHAR(500) NULL,
  run_id            VARCHAR(24)  NULL,
  created_at        DATETIME(3)  NOT NULL,
  updated_at        DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_msg_seq (session_id, seq),
  KEY idx_msg_session (session_id, seq),
  FULLTEXT KEY ft_msg_content (content) WITH PARSER ngram COMMENT '中文搜索用内置 ngram 分词',
  CONSTRAINT fk_msg_session FOREIGN KEY (session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------- 生成任务
-- 只存元信息：事件明细留在进程内存（逐条落库没有意义，见 README）。
-- 启动时把 status='running' 的行清理掉，并把对应消息标成 interrupted。
CREATE TABLE IF NOT EXISTS runs (
  id         VARCHAR(24) NOT NULL,
  user_id    CHAR(36)    NULL COMMENT '游客的 run 可以为空',
  session_id CHAR(36)    NULL,
  message_id CHAR(36)    NULL,
  status     ENUM('running','done','error','aborted') NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_runs_status (status, updated_at),
  KEY idx_runs_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
