# Requirements Document

## Introduction

{{Кратко: какую возможность даёт фича, кому и зачем. 2–4 предложения, без технологий.}}

## Requirements

### Requirement 1: {{ОБЛАСТЬ_ТРЕБОВАНИЯ_1}}

<!-- Заголовок ОБЯЗАН начинаться с числового ID: "Requirement 1: …". Буквенные ID ("Requirement A") запрещены:
     на них не построить ссылки вида _Requirements: 1.1_. -->

**Objective:** As a {{РОЛЬ}}, I want {{ВОЗМОЖНОСТЬ}}, so that {{ВЫГОДА}}

#### Acceptance Criteria

1. When {{событие}}, the {{Система}} shall {{отклик}}
2. If {{условие отказа}}, the {{Система}} shall {{отклик}}
3. While {{состояние}}, the {{Система}} shall {{отклик}}
4. Where {{опциональная фича включена}}, the {{Система}} shall {{отклик}}
5. The {{Система}} shall {{отклик}}

### Requirement 2: {{ОБЛАСТЬ_ТРЕБОВАНИЯ_2}}

**Objective:** As a {{РОЛЬ}}, I want {{ВОЗМОЖНОСТЬ}}, so that {{ВЫГОДА}}

#### Acceptance Criteria

1. When {{событие}}, the {{Система}} shall {{отклик}}
2. When {{событие}} and {{дополнительное условие}}, the {{Система}} shall {{отклик}}
3. If {{условие отказа}}, the {{Система}} shall {{отклик}}

<!-- Дальше требования идут тем же образцом. Один критерий — одно поведение.
     Ключи EARS (When/If/While/Where/shall) остаются английскими,
     переменные части — на языке спеки (spec.json.language).

     НЕЛЬЗЯ: имена фреймворков, БД, паттернов API, пути к файлам, имена классов.
     Это дизайн, его место в design.md.

     Полезные опциональные секции, если предмет требует:
     ## Non-Functional Requirements — performance / security / usability / reliability
     ## Constraints and Assumptions
     ## Success Criteria — Definition of Done, Acceptance Metrics
     ## Glossary
     ## Clarifications — ответы на /spec-analyze и /spec-clarify

     Проверка перед записью:
     - у каждого требования есть числовой ID;
     - у каждого требования есть минимум один EARS-критерий;
     - нет технологий и имён библиотек;
     - размытые слова (fast, robust, secure) заменены наблюдаемыми величинами;
     - есть хотя бы одна строка If — иначе отказы не покрыты. -->
