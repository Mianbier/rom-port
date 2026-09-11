-- MySQL schema for the ROM update service.
-- 云托管 / 云服务器部署时用。lib/store-mysql.js 启动时会自动建表，
-- 这里的脚本只是方便手动建库。

CREATE DATABASE IF NOT EXISTS roms
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE roms;

CREATE TABLE IF NOT EXISTS models (
  id              VARCHAR(64)  PRIMARY KEY,
  code            VARCHAR(64)  NOT NULL,
  name            VARCHAR(255) NOT NULL,
  aliases         JSON,
  series          VARCHAR(64),
  series_by_brand JSON,
  brand           VARCHAR(64),
  brands          JSON,
  codename        VARCHAR(64),
  supports        JSON,
  android         JSON,
  image           VARCHAR(255),
  INDEX idx_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS roms (
  id          VARCHAR(96)  PRIMARY KEY,
  model_id    VARCHAR(64)  NOT NULL,
  version     VARCHAR(64),
  branch      VARCHAR(255),
  branch_tag  VARCHAR(32),
  region      VARCHAR(32),
  android     VARCHAR(16),
  release_date     DATE,
  aspatch     DATE,
  recovery    VARCHAR(255),
  fastboot    VARCHAR(255),
  manual      TINYINT(1)   NOT NULL DEFAULT 0,
  INDEX idx_model (model_id),
  INDEX idx_branch (branch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ports (
  id          VARCHAR(96)  PRIMARY KEY,
  model_id    VARCHAR(64)  NOT NULL,
  version     VARCHAR(64),
  title       VARCHAR(255),
  content     TEXT,
  size        VARCHAR(64),
  url         TEXT,
  share_url   TEXT,
  share_code  VARCHAR(64),
  port_source      VARCHAR(32),
  pan_file_id VARCHAR(64),
  release_date     DATE,
  created_at  BIGINT,
  INDEX idx_model (model_id),
  INDEX idx_pan   (pan_file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  openid       VARCHAR(128) PRIMARY KEY,
  quota        INT          NOT NULL DEFAULT 0,
  last_sub_at  BIGINT,
  created_at   BIGINT,
  updated_at   BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS updates (
  id          VARCHAR(64)  PRIMARY KEY,
  version     VARCHAR(64),
  title       VARCHAR(255),
  content     TEXT,
  url         TEXT,
  created_at  BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kv (
  k           VARCHAR(64)  PRIMARY KEY,
  v           TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
