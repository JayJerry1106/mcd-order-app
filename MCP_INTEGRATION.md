# 麦当劳 MCP 集成说明（MCP_INTEGRATION.md）

本文档记录「麦当劳点餐助手」对麦当劳 MCP（mcd-mcp）的完整集成方式：接入协议、工具清单、调用时序、字段映射、错误码处理与踩坑记录。

---

## 1. 接入协议

| 项 | 值 |
| --- | --- |
| MCP 地址 | `https://mcp.mcd.cn/`（**根路径**，非 `/mcp` 或 `/sse`） |
| 传输协议 | Streamable HTTP（`POST`，`Accept: application/json, text/event-stream`） |
| 鉴权 | `Authorization: Bearer <MCD_MCP_TOKEN>` |
| 协议 | JSON-RPC 2.0，`method: "tools/call"` |
| 限流 | 600 次/分钟（应用侧对菜单做 60s 缓存缓解） |

### 请求示例

```json
POST https://mcp.mcd.cn/
Authorization: Bearer <TOKEN>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "query-meals",
    "arguments": { "storeCode": "15000101", "orderType": 1, "beType": 1 }
  }
}
```

### 响应结构

- `result.structuredContent`：**业务信封** `{ success, code, message, data }`
- `result.content[].text`：部分工具仅返回文本（如 `list-nutrition-foods` 返回 CSV 文本）
- `result.isError: true`：工具级错误，需从 `content[].text` 提取原因

> **注意**：业务信封的 `success:false` 与 JSON-RPC 的 `error` 是两层不同机制，前端需分别处理：前者表示业务拒绝（如售罄），后者表示协议/鉴权失败。

---

## 2. 工具清单与应用内使用

| MCP 工具 | 应用内用途 | 关键入参 |
| --- | --- | --- |
| `query-nearby-stores` | 门店搜索/选择 | `beType, searchType, city, keyword` |
| `query-meals` | 菜单（按时段返回早餐/午晚餐） | `storeCode, orderType, beType, beCode, reservationDate` |
| `query-meal-detail` | 商品详情（选配轮次 + 特调） | `storeCode, orderType, beType, code` |
| `available-coupons` | 麦麦省可领券池 | — |
| `auto-bind-coupons` | 一键领取全部可领券 | — |
| `query-my-coupons` | 我的券包 | `page, pageSize` |
| `query-store-coupons` | 当前门店可用券 | `storeCode, orderType, beType` |
| `calculate-price` | 结算核价（含 `takeWayList` 取餐方式） | `storeCode, orderType, items, needTableware, withOrder` |
| `create-order` | 创建订单 | `storeCode, items, takeWayCode, addressId, needTableware, remark, withOrder` |
| `list-nutrition-foods` | 158 项食物营养数据（CSV 文本） | — |

---

## 3. 核心调用时序

### 3.1 点餐主流程

```
启动 → query-nearby-stores（选门店）
     → query-meals（拉菜单，按时段自动区分早餐/正餐）
     → query-meal-detail（点商品：拉 rounds 选配轮次 + modification 特调）
     → [用户定制] → 加入购物车（本地持久化）
结算：
     → available-coupons + query-my-coupons + query-store-coupons（合并券池）
     → auto-bind-coupons（优惠券优先领取，一键领取）
     → 智能选券：逐张券调用 calculate-price 试算 → 取实付最低
     → calculate-price（正式核价，返回明细 + takeWayList）
     → 用户确认 → create-order（下单，返回订单号/取餐码）
```

### 3.2 核价 items 组装（最复杂的部分）

购物车每一行映射为 `items[]` 的一个元素：

```jsonc
{
  "productCode": "C1001",          // 商品编码
  "quantity": 1,
  "couponId": "xxx",               // 可选：券绑定（仅限券适用商品！）
  "couponCode": "yyy",
  "roundList": [                    // 套餐选配轮次
    {
      "round": "1",
      "comboItemList": [
        {
          "code": "M2001",          // 该轮次选择的子商品
          "quantity": 1,
          "modification": {          // 子商品的特调
            "values": [
              { "code": "MOD01", "key": "selectedKey", "quantity": 1 },
              { "code": "MOD02", "key": "unselectedKey", "quantity": 0 }
            ]
          }
        }
      ]
    }
  ],
  "modification": { "values": [] }  // 单品特调（与 roundList 二选一）
}
```

**特调（modification）关键规则**（经实测验证）：

1. 选中项传 `selectedKey`，`quantity ≥ 1`；
2. **未选中项若带 `unselectedKey` 也必须传**，`quantity = 0`；
3. `minValues=1 && maxValues=1 && values.length===1` 的为**必选项**，UI 强制单选。

### 3.3 券绑定约束（实测踩坑）

券只能绑定到其适用商品，否则 MCP 返回 `600012 促销规则不支持该商品`。因此：

- 有 `products[].productCode` 的券 → 按 code 精确匹配购物车行；
- 无 products 的券 → 按券名关键词与商品名匹配（去价格前缀、去括号备注）；
- 匹配不上的券不写入 `couponId/couponCode`，只参与试算。

### 3.4 取餐方式

`calculate-price` 返回 `takeWayList`（实测 2 种：堂食 / 外带），下单时将其中的 `code` 作为 `takeWayCode` 回传。

---

## 4. 错误码与处理

| code | 含义 | 应用处理 |
| --- | --- | --- |
| `600012` | 促销规则不支持该商品（券绑错商品） | 前端精确匹配后才绑定；报错时 toast 提示用户更换优惠券 |
| `60006` | 商品已售罄或不可售（含**时段不符**，如早餐时段点午晚餐商品） | 提示用户；菜单 API 本身按时段返回，正常路径不会触发 |
| `success: false`（信封） | 业务拒绝 | `Api.req()` 统一提取 `message` 抛出，界面 toast 展示真实原因 |
| HTTP 4xx/5xx | 协议/鉴权失败 | 服务端代理层捕获，返回 `{success:false, error}` |
| 超时 | 25s AbortController | 服务端统一超时控制，前端提示重试 |

---

## 5. 特殊处理与踩坑记录

1. **端点是根路径**：`/mcp`、`/sse`、`/messages` 等子路径均 404，正确地址为 `https://mcp.mcd.cn/`。
2. **数组被序列化为对象**：部分工具返回中，数组会变成以数字为键的对象（`{"0":{...},"1":{...}}`），需 `toArray()` 归一化。
3. **菜单按时段返回**：`query-meals` 在早餐时段只返回早餐商品。抓取午晚餐菜单需传 `reservationDate: 今天12:00`。
4. **meals 映射缺 code 字段**：`query-meals` 的 `meals` 以商品 code 为键，但条目内部不含 `code`，前端需遍历补全（否则详情跳转拿不到 code）。
5. **随单购商品**：`discountType` 含「随单购」的商品，不加购卡时 MCP 按原价计费。前端估价函数 `estimateUnitPrice()` 按同一规则估算，保证本地估价与 MCP 核价一致。
6. **限流 600 次/分钟**：服务端对 `query-meals` 做 60s 缓存；智能选券逐张试算属于批量调用，控制在一次结算内少量调用。
7. **营养数据为 CSV 文本**：`list-nutrition-foods` 返回文本而非结构化数据，前端 `parseNutritionText()` 解析为 map。

---

## 6. 实时定位链路（门店距离从何而来）

`query-nearby-stores` **不接受经纬度入参**（schema 仅 `city`/`keyword`，实测传 `"116.46,39.91"` 报「没有查询到该地址」），返回的门店**也不含坐标**，只含 `distance`（米，相对于 keyword 的解析点）。因此应用的距离能力这样构建：

```
设备定位（navigator.geolocation）
  → 逆向地理编码（Nominatim ⇄ BigDataCloud 并行竞速，各自 2.5s 超时）
      · Nominatim：zoom=18，可拿到小区/道路级 POI 名（精度最高，国内网络常不可达）
      · BigDataCloud：免密钥、国内可达，但只到区县级
      · 任一提供商给出小区级结果即采用；否则等待全部结束取最优
  → MCP query-nearby-stores（city + POI 关键词）
  → distance 升序 = 距用户由近到远
```

**实测精度规律**（同一坐标 北京建外SOHO 39.9088,116.4676）：

| keyword | MCP 最近店距离 | 说明 |
| --- | --- | --- |
| 建外SOHO | 107m | POI 级关键词，最准 |
| 朝阳区 | 226m | 区县级，参考点为区中心 |
| 不存在的关键词XYZ | 0 家（2026-10-21 复核：不再静默回退，直接返回空） | 界面提示「换个关键词试试」 |
| 济南市 + 无影山 | 1130m（金牛大厦） | **city 参数主导，跨城搜索完全正常**（实测返回 5 家济南门店） |
| 济南市 + 国贸 | 171m（北园银座家居） | 关键词在该城市无法解析时，MCP 退化为该城市级结果，仍遵守 city |

**由此做出的产品决策**：
1. 优先争取 POI 级关键词（Nominatim 高精度提供商先行返回）；
2. 仅解析到区县级时，界面明确提示「距离按区中心计算，可能偏差较大」；
3. 最近门店 > 8km 时提示「距离偏远，请确认定位地址」，防范关键词解析失败导致的虚大距离；
4. 逆向地理编码全部失败时定位不报错（软失败），引导用户手动输入城市+关键词；
5. 地名统一转简体（BigDataCloud 的 `localityLanguage=zh` 实际返回繁体，MCP 对繁/简均可解析）；
6. **城市一致性兜底校验**（济南用户反馈后新增）：手动搜索时校验返回门店是否含目标城市名，均不在目标城市则提示「关键词可能未被正确解析（已回退到默认参考点）」，防止把 A 城结果误当成 B 城结果；
7. **实时模式诚实性**：返回门店均不在目标城市时提示「关键词可能未被正确解析（已回退到默认参考点）」，防止把 A 城结果误当成 B 城结果（与第 6 点城市一致性兜底校验一致）。

**定位异常处理矩阵**：

| 场景 | 检测方式 | 产品行为 |
| --- | --- | --- |
| 浏览器不支持 | `'geolocation' in navigator` | 提示更换浏览器，保留手动搜索 |
| 非安全上下文（http + 非 localhost） | `window.isSecureContext` | 提示需 HTTPS/localhost |
| 权限已拒绝 | Permissions API 预检（Safari 无此 API 时走回调） | 不重复触发弹窗，给出地址栏设置引导 |
| 定位不可用 / 超时 | `code 2 / 3` | 自动降级为网络定位重试一次，仍失败则引导手动搜索 |
| 定位成功但无地址 | 提供商全部失败 | 面板提示 + 手动搜索兜底 |

**性能优化**：位置结果缓存 5 分钟（不重复唤醒 GPS）、逆地理编码缓存 30 分钟（按约 100m 网格）、并行请求有 4s 硬性上限、仅在用户主动点击时发起定位（不自动弹权限窗）。

---

## 7. 无 Token / 后端不可达（诚实提示，不提供模拟数据）

应用已**移除演示模式**，只运行在实时模式。当未配置 `MCD_MCP_TOKEN`（或 Pages Function 未部署 / 网络不可达 / 超时）时：

- 启动前端探测 `/api/status`，返回非 `live`（或服务端 503 / 非 JSON）即进入「需配置后端」提示页；
- 提示页诚实说明应用已移除演示模式、并给出本地（配置 `.env`）与线上（Pages Function + Secret）两种配置指引，以及「重试」按钮；
- **绝不回退到任何快照或模拟数据**，不展示任何占位门店/菜单/券；
- 门店搜索、核价、下单等全部依赖真实麦当劳 MCP；真实数据边界（如城市不匹配提示、营业状态计算）见上文第 6 点。
