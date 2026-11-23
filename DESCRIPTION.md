# AI-chat-helper: Project Description and Build Instructions

This document is the project description for development. It has two parts. Part 1 gives a summary of the project. Part 2 gives instructions to the AI coding agent. The agent uses these instructions to build the development harness and the module.

---

# Part 1: Project summary

## Goal

Build an AI module that communicates with clients for a CRM. The module does these tasks:

- It receives and sends messages in **Instagram** and in **website live chats (Jivo, Tidio)**.
- It answers questions about a catalog. The catalog can contain **all types of goods or services**.
- It **creates, tracks and cancels orders**. It uses a CRM adapter that operates with all CRMs (CRM API and webhooks). It shows the **payment link** from the CRM to the client. It tells the client about **order status changes**.
- It **sends a WhatsApp notification to a human operator** when necessary. The operator talks to the client in the **operator chat**. The module keeps the dialog in the agent memory.
- It gets its configuration from the **admin panel**.

## Applications

| Application | Purpose | Users | Technology |
|---|---|---|---|
| Backend | Channels, AI agent, CRM adapter, workers, APIs | — | Python, FastAPI |
| Admin panel | Setup only. All configuration parameters. | CRM administrators | React SPA (TypeScript) |
| Operator chat | Live chat with clients during a handoff | Operators | React SPA (TypeScript), WebSocket |

The admin panel and the operator chat are two separate applications. Admins and operators log in through the CRM (OAuth).

## Glossary

| Term | Meaning |
|---|---|
| Tenant | One CRM account or one module instance. Each tenant has its own configuration. |
| Channel | The source of the client messages: `instagram`, `jivo`, `tidio` |
| Conversation | One thread of messages with one client in one channel |
| Harness prompts | The set of prompts that you can configure: system, greeting, fallback, escalation, order confirmation, sales funnel stages |
| Catalog / menu | The products or services of the tenant. They come from the CRM catalog or from an external API. |
| Handoff | The time when a human operator answers the client. The AI does not answer during this time. |
| Operator | A CRM user with a WhatsApp phone number. The operator answers clients in the operator chat. |
| Operator pool | All operators of one tenant |
| Urgent manager | A CRM user. The module sends an urgent alert to this user when no operator accepts a handoff. |
| Urgent alert | A phone call through a telephony service, a WhatsApp text message, or the two |
| Operator chat | The separate SPA where operators talk to clients |
| Notification | A WhatsApp template message to an operator. It contains a link to the operator chat. |
| Agent memory | The dialogs and the client facts that the module keeps, with embeddings. The module uses them to find the past data again. |
| Language pack | The translated harness prompts and the example dialogs for one language |
| Dialog dataset | A set of example dialogs. The module uses them as few-shot examples for tone and language. |

## Functional requirements

### Channels
- **Jivo, Tidio**: The module receives messages through the webhooks of these services. The module sends replies through their APIs. The module shows a "typing…" indicator if the API has this function.
- **Instagram**: Use the Meta Instagram API with Instagram Login. Use the same `ChannelAdapter` interface. Refer to *Instagram integration options*.

### Configuration parameters
Each tenant has its own parameters. The module keeps a version of each change.

1. **Harness prompts**: `system`, `greeting`, `fallback`, `escalation`, `order_confirmation`, `sales_funnel.<stage>`. You can change the list of funnel stages. Default stages: greeting → needs discovery → offer → order → payment → status change notifications → feedback collection. Each prompt has one version for each language.
2. **Catalog data source**: `crm_catalog` or `external_api`. For `external_api`, set the URL, the authentication and the field mapping. The module gets the catalog at set intervals. It keeps a copy in Postgres, with embeddings for semantic search.
3. **Tone of voice**: Select a preset (`formal`, `friendly`, `playful`), or load a dialog dataset, or do the two. You can add more presets. During operation, the module finds the applicable dataset examples in pgvector. It uses them as few-shot examples. The module does not fine-tune the model.
4. **Topic restriction level**:
   - `medium`: The bot can talk about other topics for a short time. The bot moves the conversation back to the subject in a maximum of 3 messages.
   - `high`: The bot refuses all other topics in a short reply.
   - `strict`: The bot answers only about products and orders.
5. **Human-simulation delays**: `delay = min(random(min_delay, max_delay) + per_char_delay * len(reply), max_total_delay)`. The module shows "typing…" for the full delay. Defaults: `min_delay` 2 s, `max_delay` 10 s, `per_char_delay` 0.03 s, `max_total_delay` 30 s.
6. **Operator pool**: The list of operators. Each operator is a CRM user with a WhatsApp phone number.
7. **Urgent managers**: One or more CRM users. For each urgent manager, set the phone number and the communication type: `phone_call`, `whatsapp_text`, or the two.

### Languages
- The module has English and French.
- To add a language, add a **language pack**. A language pack contains translated prompts and example dialogs.
- The module finds the language of the client in each conversation.

### Orders and payment
- The `CRMAdapter` uses **OAuth** for the CRM API.
- The `CRMAdapter` has these operations: `get_catalog`, `create_order`, `get_order_status`, `cancel_order`. `create_order` returns the order ID and the **payment link**.
- The `CRMAdapter` changes the incoming **order status webhook** (CRM → module) into a domain event. Payment status changes are order status changes.
- The LLM uses these operations as **tools**.
- **Order procedure**:
  1. The bot uses the `order_confirmation` prompt. The bot waits for a clear "yes" from the client.
  2. The module calls `create_order`.
  3. The bot shows the payment link to the client.
  4. The client pays. The CRM sends the status change through the webhook.
  5. The bot tells the client about the new status.
- The bot tells the client about all order status changes.
- Before `cancel_order`, the bot uses the `order_confirmation` prompt and waits for a clear "yes".
- **Finished order**: The order has one of these statuses: `completed`, `cancelled`, `refunded`. All other orders are **unfinished**.
- **Status change during a handoff**: Do not send the status message to the client. Show the status change to the operator in the operator chat.
- **Closed channel window**: If the channel cannot deliver a status message (for example, the Instagram 24-hour window is closed, or the website visitor is offline), do these steps:
  - Unfinished order: Keep the conversation and the undelivered message for a minimum of 30 days. When the client writes again, send the undelivered message first. Then continue the conversation with the full history.
  - Finished order: Keep the conversation with a reference to the client ID.
- **Lost webhooks**: A worker gets the status of each unfinished order from the CRM at set intervals (`get_order_status`, default: 10 minutes). If the status changed, do the same steps as for a webhook.

### Human handoff
- **Triggers**: Each of these conditions starts a handoff:
  1. The client asks for a human **two times** in one conversation.
  2. The client asks for a human **with harsh words**. The module finds harsh words with a keyword list that you can configure. An LLM sentiment check also finds them.
  3. The **confidence of the AI is less than** a limit that you can configure (default: 0.6).
- **Procedure**:
  1. Send the `escalation` message to the client. Set the conversation state to `HANDOFF_PENDING`.
  2. Select an operator from the operator pool. Select by availability first, then in turn (round-robin).
  3. Send a WhatsApp notification to the operator. The notification contains a link to the conversation in the operator chat.
  4. The operator opens the link and logs in through the CRM. The operator accepts the conversation. Set the state to `HANDOFF_ACTIVE`. If the operator does not accept in the time limit (default: 1 minute), write an alert to the log. Then select the next operator. If no operator in the pool accepts, send an urgent alert to the urgent managers. At the same time, set the state to `AI_ACTIVE`. The AI continues the conversation with the client.
  5. Send the operator messages to the client channel. Send the client messages to the operator chat through the WebSocket. Do not let the AI answer the client during the handoff.
  6. When the operator sends `/out-to-AI` in the operator chat, set the state to `AI_ACTIVE`. The AI continues with the full history.
  7. Keep the full dialog in the agent memory. Include the handoff part.

### WhatsApp notifications
- Use the WhatsApp Business Cloud API **only for notifications**. The dialog does not go through WhatsApp.
- Each notification is a message that the business starts. Thus each notification must use an approved **utility template** with a link to the operator chat.
- **Development stage**: Use the `WhatsAppClient` mock. For real tests, make a Meta developer account and a Meta app with the WhatsApp product. Meta gives a free test phone number and a temporary token. You can send messages to a maximum of 5 verified phone numbers. Business verification is not necessary.
- **Production**: These items are necessary: business verification, a real phone number with an approved display name, a payment method, a permanent system-user token and an approved utility template.

### Urgent alerts to managers
- Use the communication type and the phone number of each urgent manager from the admin panel.
- `phone_call`: Make a usual phone call through Twilio. Twilio reads this text to the manager (text-to-speech): "Hello. You have unhandled order conversations. Please check in whatsapp chat". Call permission and a media component are not necessary.
- `whatsapp_text`: Send a WhatsApp template message from the business phone number. The message contains a link to the conversation in the operator chat.
- Put the telephony service behind a `TelephonyClient` interface. Thus you can replace the provider.
- Write each alert and its result in the handoff log.

Note: The WhatsApp Business Calling API is not used. It needs call permission from each manager and a media component (WebRTC or SIP).

### Agent memory
- Use Postgres with pgvector.
- Keep the messages, the conversation summaries and the client facts (name, preferences, past orders). Keep embeddings for each item.
- For each turn, get the applicable memory items.

### Data retention
- Keep the conversations, the agent memory and the client data for a **maximum of 3 years**. A daily job deletes older data.
- If a client asks to delete their data or their account, delete all data of that client: messages, memory items, embeddings, pending messages and client records. An admin starts the deletion in the admin panel.
- For unfinished orders, keep the conversation for a minimum of 30 days (refer to *Orders and payment*).

### Admin panel
- The admin panel is a React SPA (TypeScript). It uses the admin API. It is only for setup.
- Admins log in through the CRM (OAuth).
- It lets you create, read, change and delete these items: all configuration parameters, the operator pool, language packs, dialog datasets, and CRM and channel credentials, urgent managers.
- It has a function to delete all data of one client.

### Operator chat
- The operator chat is a React SPA (TypeScript). It is separate from the admin panel.
- Operators log in through the CRM (OAuth).
- It shows the conversations that the module sends to the operator. It can show more than one active conversation.
- For each conversation, it shows the summary, the full history and the order data.
- It receives client messages in real time through a WebSocket. It sends operator messages through the operator API.
- The operator sends `/out-to-AI` to give the conversation back to the AI.
- **Conversation history**: It shows the past conversations of the tenant, with the order data.
- **Handoff log**: It shows all handoffs, with the trigger, the operator, the accept time and the alerts.

## Non-functional requirements
- **Stack**: Python 3.12+, FastAPI, PostgreSQL with pgvector, SQLAlchemy 2 (async), Alembic, React with TypeScript, Docker.
- **Multi-tenant**: Each table has a `tenant_id` column.
- **Fast webhook response**: Background workers do the LLM calls, the delays and the message sends.
- **Idempotency**: Use the message ID of the provider to find and remove duplicate webhook events.
- **Security**: Do a check of the webhook signatures. Encrypt the credentials. Do not write secrets or personal client data in the logs. Each operator can see only the conversations of the applicable tenant.
- **More than one backend container**: The WebSocket events must go to the correct container. Use Postgres `LISTEN/NOTIFY`.
- **Replaceable LLM provider**: All model calls go through one `LLMProvider` interface.

## Model selection

**Decision: Start with Claude Sonnet 5.5 (`claude-sonnet-5-5`) as the main model.** Make the final selection with the eval suite after all other parts are complete. In the tests, use the `LLMProvider` mock.

The model must have these properties: good customer-support chat in English and French, correct tool calls for orders, low cost and low latency.

**Proposal: Use two model tiers behind one `LLMProvider` interface.**

| Role | Proposed model | Reason |
|---|---|---|
| Main model: conversation and tool calls | **Claude Sonnet 5.5** (`claude-sonnet-5-5`) | It has good results for agent tasks and tool use. The Sonnet models have scores near the top on τ²-bench (tool calls for customer service). They have approximately 89% on MMMLU (multilingual). The cost is much lower than Opus models. |
| Fast model: classifiers (intent, harsh-word sentiment, confidence, language detection, summaries) | **Claude Haiku 5.5** (`claude-haiku-5-5`) | It has the lowest cost and the highest speed in its family. It is sufficient for short classification tasks. |
| Other models to test | GPT-6 Sol, Gemini Flash family | They have a similar price and speed. Test them with the same eval suite (Part 2, step 11). |

Benchmark data (November 2026):

| Area | Benchmark | Results |
|---|---|---|
| Tool calls for customer support | τ²-bench (retail, airline, telecom) | The latest Claude Sonnet models have approximately 86–92% for retail and 98% for telecom (vendor system cards, 4.5/4.6 models). On a community leaderboard, the top models have an average of approximately 82–83%. The user simulator can change the scores by a maximum of approximately 24 points. Compare only the results from the same setup. |
| Function calls | BFCL v4 | The model developers supplied most of the top scores. We found no verified November 2026 scores for the latest models. |
| Multilingual (French included) | MMMLU / Global-MMLU-Lite FR | The latest models have approximately 89–93%. We found only a small quantity of 2026 data for French. |
| Cost and speed | Artificial Analysis | Sonnet 5.5: approximately 116–127 tokens/s. Haiku 5.5: approximately 137–243 tokens/s. Prices: not examined at this time. |

**Caution**: The public data for the latest models is not complete. Some sources do not agree. Make the final selection with the eval suite of this project (Part 2, step 11). Use real English and French dialogs and the real tool schemas.

Sources:
- [τ²-bench-Verified (Amazon AGI)](https://github.com/amazon-agi/tau2-bench-verified)
- [Tau-Bench explained (Cekura)](https://www.cekura.ai/blogs/tau-bench)
- [τ²-bench Retail leaderboard (Respan)](https://www.respan.ai/models/benchmarks/tau2-bench-retail)
- [τ²-bench Telecom (benchmarklist)](https://benchmarklist.com/benchmarks/tau2_bench_telecom/)
- [Claude Sonnet 4.6 System Card](https://assets.claude.com/78073f739564e986ff3e28522761a7a0b4484f84.pdf)
- [Claude Opus 4.5 System Card](https://assets.claude.com/bf10f64990cfda0ba858290be7b8cc6317685f47.pdf)
- [BFCL v4 leaderboard (BenchLM)](https://benchlm.ai/benchmarks/bfcl-v4)
- [MMMLU leaderboard (llm-stats)](https://llm-stats.com/benchmarks/mmmlu)
- [MMMLU French (leaderboard.cn)](https://leaderboard.cn/en/benchmarks/mmmlu-fr)
- [Artificial Analysis model leaderboard](https://artificialanalysis.ai/leaderboards/models?deprecation=all)
- [Claude Haiku 5.5 review (eesel)](https://www.eesel.ai/blog/claude-haiku-5-5-review)
- [Claude Haiku 5.5 benchmarks, specs (kingy.ai)](https://kingy.ai/blog/claude-haiku-5-5-benchmarks-specs-sol-luna/)

## Instagram integration options

**Decision: Use the Meta Instagram API with Instagram Login.** Prices: not examined at this time.

| Method | Legal status | Notes |
|---|---|---|
| **Meta Instagram API with Instagram Login (selected)** | Official. Meta App Review and Business Verification are necessary. | A Facebook Page is not necessary. The reply window is 24 hours. The Human Agent tag gives 7 days, for human replies only. Use this tag for operator replies. |
| Meta Instagram API through Facebook Login (Messenger Platform) | Official | A linked Facebook Page is necessary. |
| Through the Instagram channel of Tidio or Jivo | Official. These vendors use the Meta API. | It uses the live-chat adapters that we have. We have less control of the bot logic. |
| SaaS bot builders (ManyChat and others) | Official | It does the same work as our AI. |
| Unofficial private API (instagrapi) | **It violates the Instagram Terms of Service.** The risk of an account ban is high. | Do not use. |

Sources: [Meta Instagram Platform overview](https://developers.facebook.com/docs/instagram-platform/overview/), [Instagram messaging limits (Conferbot)](https://www.conferbot.com/limits/instagram), [Tidio Instagram chatbot](https://www.tidio.com/blog/instagram-chatbot/), [Instagram chatbots compared (respond.io)](https://respond.io/blog/best-instagram-chatbots), [instagrapi (PyPI)](https://pypi.org/project/instagrapi), [Unofficial API risks (bot.space)](https://www.bot.space/blog/the-dangers-of-unofficial-instagram-dm-apis-why-theyll-get-you-banned)

## Decisions

| # | Item | Decision |
|---|---|---|
| 1 | Instagram integration | Meta Instagram API with Instagram Login |
| 2 | CRM API authentication | OAuth |
| 3 | CRM webhook | Order status changes, CRM → module |
| 4 | Order flow | The CRM gives a payment link. The bot shows it. The bot tells the client about the status changes. |
| 5 | WhatsApp | Only for notifications to operators. Mock and Meta test number in development. |
| 6 | Operator dialog | In the operator chat, not in WhatsApp |
| 7 | Frontends | Admin panel and operator chat: two separate React SPAs (TypeScript) |
| 8 | User login | Admins and operators log in through the CRM (OAuth) |
| 9 | AI model | Start with Claude Sonnet 5.5. Confirm with the eval suite after all other parts are complete. |
| 10 | Prices | Not examined at this time |
| 11 | Status change during a handoff | Only the operator sees it, in the operator chat |
| 12 | Closed channel window | Unfinished order: keep the conversation and the undelivered message for a minimum of 30 days, and continue when the client writes again. Finished order: keep the conversation with the client ID. |
| 13 | Lost webhooks | A worker checks the status of unfinished orders at set intervals |
| 14 | Finished order statuses | `completed`, `cancelled`, `refunded` |
| 15 | No operator accepts | Send an urgent alert to the urgent managers. Give control back to the AI at the same time. |
| 16 | Data retention | A maximum of 3 years, or until the client asks to delete their data or account |
| 17 | Conversation history and handoff log | In the operator chat |
| 18 | Urgent alert types | Phone call through Twilio (text-to-speech) and WhatsApp text message. Set the type and the phone number for each manager in the admin panel. |

## Open items (TBD)
- The final AI model (decision 9). Start with Claude Sonnet 5.5.
- The prices (decision 10).

---

# Part 2: Instructions for the AI coding agent (development harness)

You build **AI-chat-helper**. Obey the rules and do the steps below. Do not add functions that Part 1 does not specify. If an item is TBD, build an interface and a mock implementation. Ask before you select a real provider.

## Rules
1. Backend: Use Python 3.12+, FastAPI, async SQLAlchemy 2, Alembic and PostgreSQL 16 with pgvector. Use Pydantic v2 for all schemas and settings.
2. Backend tools: a virtual environment (`python -m venv .venv`) and `pip` for dependencies (declared in `pyproject.toml`), `ruff` for lint and format, `mypy --strict` on `app/`, `pytest` with `pytest-asyncio`.
3. Frontends: Use React with TypeScript and Vite. Use ESLint and Vitest. Make the API client types from the FastAPI OpenAPI schema.
4. Put each external system behind an interface. Make a **mock** implementation for each interface: `CRMAdapter` (OAuth included), `ChannelAdapter`, `WhatsAppClient`, `TelephonyClient`, `LLMProvider`, `EmbeddingProvider`, `CatalogSource`.
5. Do not let tests call real external APIs or real LLMs. Use mocks and recorded fixtures. Run live LLM evals only with `make eval`.
6. Add a `tenant_id` column to each database table. Filter each query by tenant.
7. In each webhook handler, do these steps: validate the event, remove duplicates, put the event in the queue, return 200. Do all other work in the workers.
8. Do not write secrets or message text in the logs at INFO level.
9. Keep the prompts in the database, in the tenant configuration. Put the default prompt templates in `app/prompts/defaults/{lang}/*.md`. Load them with a migration.

## Target repository layout
```
app/
  main.py                 # FastAPI app factory
  settings.py             # pydantic-settings
  db/                     # models, session, alembic
  domain/                 # conversation state machine, handoff rules, delay calc, order flow
  auth/                   # CRM OAuth login, sessions, roles (admin, operator)
  adapters/
    crm/       base.py  generic_http.py  factory.py  mock.py
    channels/  base.py  jivo.py  tidio.py  instagram.py  mock.py
    whatsapp/  base.py  cloud_api.py  mock.py
    telephony/ base.py  twilio.py  mock.py
    llm/       base.py  anthropic.py  mock.py
    embeddings/ base.py  mock.py
    catalog/   base.py  crm_catalog.py  external_api.py  mock.py
  agent/                  # prompt assembly, tools, memory retrieval, few-shot retrieval
  workers/                # message processing, delayed send, catalog sync, notifications
  admin/                  # admin API routers
  operator/               # operator API routers, WebSocket
  prompts/defaults/{en,fr}/
frontend/
  admin/                  # React SPA: admin panel
  operator/               # React SPA: operator chat
tests/
  unit/  integration/  e2e/
evals/
  datasets/{en,fr}/       # scripted dialogs with expected outcomes
  run_evals.py
mocks/                    # standalone mock servers for docker compose
docker-compose.yml
Makefile
.env.example
```

## Build procedure

Complete each step before you start the next step. All tests of the step must pass.

1. **Scaffold**: Make the repository layout and `pyproject.toml`. Configure ruff, mypy and pytest. Make the two Vite projects in `frontend/`. Make the `Makefile` with these targets: `make dev`, `make test`, `make lint`, `make eval`. Make `docker-compose.yml` with Postgres with pgvector, the backend, the two SPAs and the mocks. Make `.env.example`. Add the `/healthz` and `/readyz` endpoints.
2. **Data model and migrations**: Make these tables: tenants, tenant_config (with versions), prompts, channels, conversations (with state), messages, users (CRM user ID, role: admin, operator, urgent manager), operators (user, WhatsApp number, availability), urgent_managers (user, phone number, communication types), handoffs, clients (channel user ID), orders (CRM order ID, payment link, status), pending_messages (undelivered messages, with a minimum retention of 30 days), catalog_items (with embedding), memory_items (with embedding), dialog_examples (with embedding, language and tone tag), language_packs, processed_events (for duplicate control).
3. **Interfaces and mocks**: Make the interfaces and mocks for all adapters in rule 4. Put mock servers in `mocks/`. The CRM mock server has an OAuth endpoint, the order API with payment links, and a function to send status webhooks. The e2e tests use the mock servers to run the real HTTP code.
4. **Authentication**: Make the CRM OAuth login for admins and operators. Make the sessions and the role checks (admin, operator).
5. **Domain logic**: Write pure functions. Write unit tests for all of them. Make these items:
   - The conversation state machine: `AI_ACTIVE → HANDOFF_PENDING → HANDOFF_ACTIVE → AI_ACTIVE`.
   - The handoff trigger check: the client asks for a human two times, the client uses harsh words, or the AI confidence is low.
   - The topic restriction policy: `medium` (with the 3-message return rule), `high`, `strict`.
   - The delay calculation: a random value from the range, plus a value for each character, with a maximum limit.
   - The order flow: confirmation → create → payment link → status change → client message.
6. **Agent core**: Make the prompt assembly from these parts: system prompt, restriction level, tone, funnel stage, language. Get few-shot examples from `dialog_examples`. Get the applicable memory items. Make the LLM tool loop with these tools: `search_catalog`, `create_order`, `get_order_status`, `cancel_order`, `request_human`. Before `create_order` and `cancel_order`, the confirmation check must run.
7. **Channels**: Make the Jivo, Tidio and Instagram adapters. Each adapter changes an incoming webhook into a normalized message. Each adapter sends replies and shows the typing indicator. The Instagram adapter uses the Meta Instagram API with Instagram Login. It uses the Human Agent tag for operator replies.
8. **CRM webhook and status check**:
   - Receive the order status webhook. Ignore events that are older than the last known status. Update the order.
   - If a handoff is active, show the status change in the operator chat only. If not, send a status message to the client in the channel of the conversation.
   - If the channel cannot deliver the message, keep it in `pending_messages`. When the client writes again, send it first.
   - Make the worker that gets the status of each unfinished order at set intervals.
9. **Handoff and operator chat backend**: Select an operator from the pool, with a time limit to accept. Write an alert to the log when the time limit ends. If no operator accepts, send the urgent alerts to the urgent managers (phone call through `TelephonyClient`, WhatsApp text, or the two) and give control back to the AI. Send the WhatsApp notification with the link to the operator chat. Make the operator API and the WebSocket. Send the messages between the client channel and the operator chat. Make the `/out-to-AI` command. Keep the transcript in the memory. Use Postgres `LISTEN/NOTIFY` for the WebSocket events.
10. **Admin API and the two SPAs**:
    - Admin API: Make the create, read, change and delete operations for these items: configuration, prompts, operators, language packs, dialog datasets (load with embedding), catalog source settings.
    - Admin panel SPA: Make the screens for all admin API items.
    - Operator chat SPA: Make the conversation list, the conversation view (summary, history, order data), the message input and the `/out-to-AI` command. Make the conversation history view and the handoff log view.
    - Admin panel: Make the function that deletes all data of one client.
11. **Eval harness** (`make eval`): Run the scripted English and French dialogs from `evals/datasets/` with a real model. Measure these items:
    - Correct tool calls: the correct tool, the correct arguments, and a confirmation before create and cancel.
    - Correct behavior for each restriction level.
    - Correct handoff triggers.
    - Correct language: the reply language is the same as the client language.
    - Latency and token cost for each conversation.

    Make a comparison table for each model that you configure (main tier and fast tier). Use this table to select the model (decision 9).
12. **Catalog sync worker**: Make the worker for the `crm_catalog` and `external_api` sources. It does the field mapping and the embeddings, and it runs on a schedule.
13. **Data retention job**: Make the daily job that deletes data older than 3 years. Do not delete conversations of unfinished orders that are less than 30 days old.

## Test requirements
- Unit tests: Test all code in `domain/`. The branch coverage must be 100%.
- Integration tests: Run them with a real Postgres (testcontainers or the compose service).
- Frontend tests: Use Vitest for the components of the two SPAs.
- E2E tests: Run these full scenarios through the mock servers:
  - The client asks about a product. The bot answers from the catalog.
  - The client makes an order. The bot asks for confirmation. The module calls `create_order` one time. The bot shows the payment link.
  - The CRM mock sends a "paid" status webhook. The bot tells the client.
  - The CRM mock sends a status webhook during a handoff. Only the operator chat shows it.
  - The channel window is closed. The CRM mock sends a status webhook. The module keeps the message. The client writes again after some days. The bot sends the kept message first and continues the conversation.
  - The CRM mock changes a status but does not send a webhook. The status check worker finds the change. The bot tells the client.
  - The client cancels an order. The bot asks for confirmation. The module calls `cancel_order`.
  - The client asks for a human two times. The module sends a WhatsApp notification with a link. The operator logs in and accepts. The messages go between the client and the operator chat. The operator sends `/out-to-AI`. The AI continues. The transcript is in the memory.
  - The client asks for a human with harsh words. The handoff starts immediately.
  - The operator does not accept in the time limit. The module writes an alert to the log and selects the next operator.
  - No operator in the pool accepts. The module sends the urgent alerts to the urgent managers, with the communication type of each manager. The AI continues the conversation.
  - An admin deletes the data of one client. No messages, memory items or embeddings of that client stay in the database.
  - The retention job deletes data older than 3 years.
  - The client sends messages about other topics. Test each restriction level.
  - A French conversation stays in French.
  - An operator of one tenant cannot see the conversations of a different tenant.
- Make the `LLMProvider` mock return scripted responses, with tool calls. This makes the tests deterministic.

## Definition of done (for each step)
- `make lint` and `make test` pass.
- Each new function has tests.
- You can reverse each migration.
- If the configuration or the endpoints change, update `.env.example` and `README.md`.
