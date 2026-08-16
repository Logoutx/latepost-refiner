# DeepSeek 响应可观测性契约

Universal 对模型失败只做有证据的分类，不把“没有内容”一概解释为内容审查。

| 错误码 | 含义 | 可重试 |
|---|---|---|
| `MODEL_REFUSAL` | 响应明确包含 refusal | 否 |
| `CONTENT_FILTER` | `finish_reason=content_filter` | 否 |
| `MODEL_EMPTY_RESPONSE` | API 成功返回但没有 choice，原因不明 | 是 |
| `MODEL_EMPTY_CONTENT` | 有 choice、无 refusal/filter，但正文为空，原因不明 | 是 |
| `API_TRANSIENT` | 网络错误、408/409/429 或 5xx | 是 |
| `OUTPUT_MISSING` / `OUTPUT_EMPTY` / `OUTPUT_NOT_UPDATED` | 模型调用已结束，但声明产物不满足写入后置条件 | 否 |

每条模型失败可以带一个 `providerSignal`：

```json
{
  "provider": "deepseek",
  "finishReason": "content_filter",
  "refusalPresent": false,
  "choiceCount": 1,
  "httpStatus": null,
  "requestId": "req_example"
}
```

该对象会进入 `run.json.execution.failure/failures`、失败 agent 的 `events.jsonl` 事件，以及终态 `run-state.json.failure`。所有入口都只保留上述白名单字段；message、provider 响应正文、prompt、转录正文、工具参数、网页正文和 API key 不进入实时 trace。`run-state.json` 的终态 failure 也不保存 message。

判断边界：

- 只有 `MODEL_REFUSAL` 或 `CONTENT_FILTER` 能支持“模型明确拒绝/内容过滤”的结论。
- `MODEL_EMPTY_RESPONSE` / `MODEL_EMPTY_CONTENT` 只能说明返回为空，不能证明发生审查。
- `finishReason=stop` 且 `refusalPresent=false` 的 `OUTPUT_*` 表示模型正常结束后没有履行文件契约，不应误标为审查。
- request id 和 HTTP 状态用于向 provider 对账；它们不是正文证据。
