# Flow Builder Impact Assessment Guide

Use this reference during Step 5 to assess how code changes affect Shopware Flow Builder automation flows.

## Architecture overview

```
Event dispatch
  -> FlowDispatcher intercepts FlowEventAware events
  -> FlowLoader / CachedFlowLoader loads compiled flow definitions
  -> FlowFactory creates StorableFlow from event data
  -> FlowExecutor processes sequence chain:
       IfSequence -> rule evaluation via FlowRuleScopeBuilder
       ActionSequence -> action handler via FlowAction::handleFlow()
```

Buffered execution (v6.8+, feature flag `FLOW_EXECUTION_AFTER_BUSINESS_PROCESS`):
- Flows are queued in `BufferedFlowQueue` instead of executing inline
- `BufferedFlowExecutionTriggersListener` fires them after HTTP/worker/console termination
- Max execution depth: 10 (prevents infinite loops)

## Built-in flow actions

Source: `src/Core/Content/Flow/Dispatching/Action/`

| Action class | Purpose | Entity dependencies |
| --- | --- | --- |
| `SendMailAction` | Send email from template | Order, Customer, MailTemplate |
| `SetOrderStateAction` | Transition order state machine | Order, StateMachine (transactional) |
| `GenerateDocumentAction` | Generate invoice/credit/delivery documents | Order, Document |
| `GrantDownloadAccessAction` | Grant customer download access | Order, Product |
| `AddOrderTagAction` | Add tag to order | Order, Tag |
| `RemoveOrderTagAction` | Remove tag from order | Order, Tag |
| `AddOrderAffiliateAndCampaignCodeAction` | Set affiliate/campaign on order | Order |
| `SetOrderCustomFieldAction` | Set custom field on order | Order |
| `ChangeCustomerGroupAction` | Change customer group | Customer, CustomerGroup |
| `ChangeCustomerStatusAction` | Activate/deactivate customer | Customer |
| `AddCustomerTagAction` | Add tag to customer | Customer, Tag |
| `RemoveCustomerTagAction` | Remove tag from customer | Customer, Tag |
| `AddCustomerAffiliateAndCampaignCodeAction` | Set affiliate/campaign on customer | Customer |
| `SetCustomerCustomFieldAction` | Set custom field on customer | Customer |
| `SetCustomerGroupCustomFieldAction` | Set custom field on customer group | CustomerGroup |
| `StopFlowAction` | Halt flow execution | None |

## Flow rule classes

Source: `src/Core/Content/Flow/Rule/`

| Rule class | Evaluates |
| --- | --- |
| `OrderCreatedByAdminRule` | Whether order was created by admin |
| `OrderCustomFieldRule` | Order custom field values |
| `OrderDeliveryStatusRule` | Delivery state machine state |
| `OrderDocumentTypeRule` | Document type on order |
| `OrderDocumentTypeSentRule` | Whether document type was sent |
| `OrderStatusRule` | Order state machine state |
| `OrderTagRule` | Tags on order |
| `OrderTrackingCodeRule` | Tracking code presence |
| `OrderTransactionStatusRule` | Payment transaction state |

Rule evaluation uses `FlowRuleScope` built by `FlowRuleScopeBuilder` from Order + Context.

## Aware interfaces

Events must implement `FlowEventAware` to trigger flows. Data is extracted via storers:

| Aware interface | Stored data | Storer class |
| --- | --- | --- |
| `OrderAware` | Order ID, lazy-loads order entity | `OrderStorer` |
| `CustomerAware` | Customer ID, lazy-loads customer | `CustomerStorer` |
| `OrderTransactionAware` | Transaction ID | `OrderTransactionStorer` |
| `MailAware` | Mail struct, sales channel, timezone | `MailStorer` |
| `ProductAware` | Product ID, lazy-loads product | `ProductStorer` |
| `UserAware` | User ID, lazy-loads user | `UserStorer` |
| `CustomerGroupAware` | Customer group ID | `CustomerGroupStorer` |
| `LanguageAware` | Language ID | `LanguageStorer` |
| `NewsletterRecipientAware` | Newsletter recipient | `NewsletterRecipientStorer` |
| `CustomerRecoveryAware` | Recovery token, customer ID | `CustomerRecoveryStorer` |
| `MessageAware` | Symfony Email object | `MessageStorer` |
| `CustomAppAware` | Custom app data | `CustomAppStorer` |
| `ScalarValuesAware` | Key-value pairs | `ScalarValuesStorer` |

## State machine events that trigger flows

State machine transitions fire flow events with these patterns:
- `state_machine.{technicalName}_changed`
- `{side}.{technicalName}.{stateName}` (e.g., `state_enter.order.state.completed`)

Flow-triggering state machines:
- `order.state` (open, in_progress, completed, cancelled)
- `order_delivery.state` (open, shipped, returned, cancelled)
- `order_transaction.state` (open, paid, refunded, cancelled, etc.)

## Cached flow payload

- `CachedFlowLoader` caches compiled flow definitions with key `'flow-loader'`
- Cache is invalidated on `FlowEvents::FLOW_WRITTEN_EVENT`
- `FlowPayloadUpdater` recompiles flow payloads when flow definitions change
- Changes to entity definitions or event payloads can cause stale cache issues

## Impact decision matrix

Use this to decide whether your change affects Flow Builder:

| If your change touches... | Check for flow impact... |
| --- | --- |
| Files in `src/Core/Content/Flow/` | Direct flow code change - always assess |
| Any class implementing `FlowEventAware` | Event payload or dispatch may change |
| Any class implementing `FlowAction` | Action behavior may change |
| Files in `src/Core/Content/Flow/Rule/` | Flow conditional logic may change |
| Files in `src/Core/Framework/Rule/` | Framework rules used by flow conditions |
| State machine definitions or transitions | Flow triggers may change |
| Entity definitions that flow actions read/write | Action data assumptions may break |
| Custom field definitions | Custom field rules and actions may be affected |
| Order/Customer/Product entity fields | Storer data extraction may change |
| `FlowLoader`, `CachedFlowLoader` | Flow loading/caching behavior |
| Mail template system | `SendMailAction` behavior |
| Document generation system | `GenerateDocumentAction` behavior |

## Impact assessment output format

```md
## Flow Builder Impact

- events affected: <list or "none detected">
- actions affected: <list or "none detected">
- rules affected: <list or "none detected">
- entity/DAL impact: <description or "none detected">
- state machine impact: <description or "none detected">
- risk level: <none|low|medium|high>
- recommended flow validation: <specific flows to test or "standard regression suite">
```

## Risk levels

- **none**: changed files do not appear in the impact matrix
- **low**: changes touch flow-adjacent code but do not modify interfaces, payloads, or behavior
- **medium**: changes modify entity fields, event data, or rule evaluation logic used by flows
- **high**: changes directly modify flow actions, dispatching, execution, or state machine transitions

## App flow actions

Third-party apps can register flow actions via `AppFlowActionProvider`:
- `AppFlowActionEvent` wraps app-defined actions
- Changes to the flow action interface contract affect all app actions
- `FlowExecutor` delegates app actions through `AppFlowActionProvider`
