-- Схема демо-агента поддержки. Своя, маленькая: CRM-схему не переносим.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- База знаний: документы и куски с полнотекстом, триграммами и вектором
CREATE TABLE IF NOT EXISTS kb_documents (
  id          serial PRIMARY KEY,
  slug        text UNIQUE NOT NULL,
  title       text NOT NULL,
  source      text NOT NULL,              -- путь/URL исходника
  valid_from  date,
  valid_to    date,                       -- NULL = действует
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id          serial PRIMARY KEY,
  document_id int NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  idx         int NOT NULL,
  heading     text,
  content     text NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('russian', coalesce(heading, '') || ' ' || content)) STORED,
  embedding   vector(1024)
);
CREATE INDEX IF NOT EXISTS kb_chunks_tsv ON kb_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS kb_chunks_trgm ON kb_chunks USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS kb_chunks_vec ON kb_chunks USING hnsw (embedding vector_cosine_ops);

-- Каталог магазина: цены в копейках (BigInt), без float
CREATE TABLE IF NOT EXISTS catalog_items (
  sku             text PRIMARY KEY,
  name            text NOT NULL,
  vendor          text NOT NULL,
  category        text NOT NULL,
  unit            text NOT NULL DEFAULT 'лицензия',
  term_months     int,                    -- срок лицензии/подписки; NULL = бессрочная
  price_cents     bigint NOT NULL,
  stock           int NOT NULL DEFAULT 0, -- доступно ключей/коробок; -1 = электронная поставка без ограничений
  lead_days       int,                    -- срок поставки, раб. дней; NULL = в фиде нет, уточняет менеджер
  url             text,                   -- карточка товара в магазине
  in_registry     boolean NOT NULL DEFAULT false, -- в реестре российского ПО
  description     text NOT NULL DEFAULT '',
  search_text     text GENERATED ALWAYS AS (sku || ' ' || name || ' ' || vendor || ' ' || category || ' ' || description) STORED
);
-- базы, созданные до фида магазина
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE catalog_items ALTER COLUMN lead_days DROP NOT NULL, ALTER COLUMN lead_days DROP DEFAULT;
CREATE INDEX IF NOT EXISTS catalog_trgm ON catalog_items USING gin (search_text gin_trgm_ops);
-- Полнотекст с весами: название важнее вендора, вендор — категории, категория — описания.
-- 'russian' стеммит кириллицу и английские слова (english_stem для латиницы).
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('russian', sku || ' ' || name), 'A') ||
  setweight(to_tsvector('russian', vendor), 'B') ||
  setweight(to_tsvector('russian', category), 'C') ||
  setweight(to_tsvector('russian', description), 'D')
) STORED;
CREATE INDEX IF NOT EXISTS catalog_tsv ON catalog_items USING gin (search_tsv);

-- Особые условия: скидки за объём, продление, партнёрам, госзаказчикам, отсрочка
CREATE TABLE IF NOT EXISTS price_rules (
  id            serial PRIMARY KEY,
  code          text UNIQUE NOT NULL,
  title         text NOT NULL,
  applies_to    text NOT NULL DEFAULT '*',  -- '*', 'category:<…>', 'vendor:<…>', 'sku:<…>'
  min_qty       int NOT NULL DEFAULT 1,
  discount_pct  int NOT NULL DEFAULT 0,     -- целые проценты
  requires      text,                       -- условие, которое клиент должен подтвердить: renewal | partner | gov | edu
  stackable     boolean NOT NULL DEFAULT false,
  note          text NOT NULL DEFAULT ''
);

-- Диалоги и сообщения (чат и почта)
CREATE TABLE IF NOT EXISTS conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       text NOT NULL,              -- 'chat' | 'email'
  customer_name text,
  customer_email text,
  customer_company text,
  customer_inn  text,
  subject       text,
  status        text NOT NULL DEFAULT 'open', -- open | waiting_manager | closed
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,            -- user | assistant | manager | system
  content         text NOT NULL,
  meta            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, id);

-- КП и счета: черновик → подтверждено менеджером → отправлено
CREATE SEQUENCE IF NOT EXISTS doc_number_seq START 101;
CREATE TABLE IF NOT EXISTS proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          text NOT NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'draft', -- draft | approved | sent | rejected
  customer        jsonb NOT NULL DEFAULT '{}',
  items           jsonb NOT NULL,           -- [{sku,name,qty,unit_cents,discount_pct,rule,sum_cents}]
  subtotal_cents  bigint NOT NULL,
  discount_cents  bigint NOT NULL DEFAULT 0,
  total_cents     bigint NOT NULL,
  vat_cents       bigint NOT NULL DEFAULT 0,
  notes           text NOT NULL DEFAULT '',
  valid_until     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  sent_at         timestamptz
);

CREATE TABLE IF NOT EXISTS invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          text NOT NULL,
  proposal_id     uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'draft',
  total_cents     bigint NOT NULL,
  vat_cents       bigint NOT NULL DEFAULT 0,
  due_date        date,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Запуски агента: токены и ₽ за каждое обращение
CREATE TABLE IF NOT EXISTS agent_runs (
  id              bigserial PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  channel         text NOT NULL,
  model           text NOT NULL,
  steps           int NOT NULL,
  input_tokens    int NOT NULL DEFAULT 0,
  output_tokens   int NOT NULL DEFAULT 0,
  cache_read_tokens int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  embed_tokens    int NOT NULL DEFAULT 0,
  cost_rub        numeric(12,4) NOT NULL DEFAULT 0,
  duration_ms     int NOT NULL DEFAULT 0,
  tools           jsonb NOT NULL DEFAULT '[]',
  answered        boolean NOT NULL DEFAULT true,
  escalated       boolean NOT NULL DEFAULT false,
  verify_issues   jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Вопросы без ответа и эскалации — отчёт «пробелы в базе знаний»
CREATE TABLE IF NOT EXISTS escalations (
  id              bigserial PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  kind            text NOT NULL,            -- no_answer | needs_human | low_confidence | verify_failed
  question        text NOT NULL,
  reason          text NOT NULL,
  resolved        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Исходящая почта (журнал: если SMTP не настроен, письмо всё равно видно в панели)
CREATE TABLE IF NOT EXISTS outbox (
  id              bigserial PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  to_email        text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  attachments     jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL DEFAULT 'queued', -- queued | sent | logged | failed
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
