# Приложение «Аналитика сделок CRM» — сдача по замечаниям раунда 3

Версия исходников в этой сдаче: после v4 добавлена правка гейта (см. ниже), назовём её v5.
Рабочая копия: `C:\Projects\bp-by-opencode.loc\crm-dashboard\`.
Архив исходников (без node_modules): `crm-dashboard-source.zip`.

## Карта правок по замечаниям

Ссылки из замечаний раунда 3 (файл `server.js`):

- KPI «Выиграно» — только `stageSemanticId === 'S'`: строка-константа `wonStage` в `buildDashboard()` (`stages.find(s => s.stageSemanticId === 'S')`); открытые считаются там же по стадиям, где семантика не `S` и не `F`.
- Сводка и KPI через `POST /v1/deals/aggregate`: функция `loadStageAggregation()` (`/v1/deals/aggregate`, `groupBy: 'stageId'`).
- `/v1/deals/search` только для 10 последних сделок с `select`: функция `loadRecent()` (`limit: 10`, `select: [...]`).
- try/catch в обработчиках: `try { … } catch (err) { … }` вокруг диспетчера маршрутов (в т.ч. `/api/meta`, `/api/data`, `/api/me`).
- Backoff на `429`: в `vibeCall()` — `if (res.status === 429 && attempts < 5)`, пауза с учётом `Retry-After`, кап 60 с.
- Понятные сообщения `401/403/502`: `friendlyError(status)` и его вызовы в catch и в `/api/me`.

Правка в этой версии (v5): гейт `/api/*` переведён с `X-Vibe-Authorization` на **`X-Vibe-User-Id`** (проверка наличия заголовка `x-vibe-user-id`, иначе `401`) — см. замечание про опознанность посетителя. Апстрим-вызовы `/v1/*` идут с `X-Api-Key` (лицо — владелец ключа).

## Что изменено ранее и учтено

- v2: KPI + агрегаты + лимит 10 + защита `/api/*`.
- v3: гейт по `X-Vibe-Authorization` (заменён на `X-Vibe-User-Id` в v5), `/api/me`, сообщения ошибок.
- v4: апстрим `/v1/*` переведён на `X-Api-Key` (устранён `401` в `/api/data`).
- v5: гейт по `X-Vibe-User-Id` (эта сдача).

## Инфра / правки платформы (вне кода)

- Политика доступа сервера `dd6aa2e1-…` (поддомен `app-c52c89249e3e`): приведена к `OWNER_ONLY` (сервисная модель «личный ключ → владелец»).
- Рекомендация по скоупам: рантайм-ключ сузить до `crm`; `vibe:infra` на отдельном ключе для деплоя; рантайм-ключ `READONLY`.
- Портал решения: `b24-yfbqyg.bitrix24.ru` (подтверждено `GET /v1/me`).