# True Admin product editor GET: source contract and read-only projection

Captured 2026-10-15T04:25:09.632991+00:00. Read-only source investigation; no PHP, HTTP endpoint, database, provider, browser, heavy test or typecheck was executed. No repository source was edited. JSON companion: `/tmp/cinashop-product-editor-get-source-20261015.json`.

## Route, ID zero and copy entry

GET `/adminapi/product/product/:id` maps to `get_product_info` -> service.getInfo -> DAO.search().with(coupons).find(id). [S01,S02,S04] Return data has exactly `{tempList,cateList,productInfo}`; the controller standard success envelope wraps it. There is no source creation-default branch. For normal missing row0 getInfo throws 商品不存在. It also reads deleted/hidden/nonplatform products without adding owner/is_del/status filters.

`productInfoApi(id)` is the actual detail helper. `productEditApi(id)` calls category `product/category/:id` and must not be implemented as this endpoint. [S24] Vue calls getInfo only for nonzero route id or query.copy; route id0 loads productCache instead; new empty route keeps local defaults. GET copy is the exact same positive source-id GET as edit. At submit only, query.copy sets formValidate.id=0 and soure_link=""; it does not strip SKU/card/fixed contents. The component assigns outer type (normally0, scraped route -1) to the body later; stored owner type in the GET is not a copy marker. [S25]

## Envelope selectors

- `tempList`: platform `type=0,relation_id=0` shipping templates, id/name row array sorted sortDESC,idDESC, without source status/is_del filter. It does not switch to the product owner in getInfo. The separate get_template?id endpoint does resolve existing owner. [S13,S14,S02]
- `cateList`: platform shown (`is_show=1,type=0,relation_id=0,level=-1`) category tree assembled from value=id,label=cate_name,pid rows sorted sortDESC,idDESC. No disabled-leaf flags (the related code is commented). The global tree helper body was not found in the readable checkout, so exact orphan/cycle behavior is not claimed. [S15,S16,S17]
- The current Vue getInfo consumer ignores envelope tempList/cateList: it loads categories/templates through separate helpers. Still return them for the true endpoint contract. [S25]

## Complete main row and transforms

The source starts with the whole installer main row, not a reduced editor whitelist. The complete 80 column map below records storage defaults; those defaults are **not** a GET0 response. Only explicit float/bool/date/accessor conversions can be guaranteed by source. Untouched numeric PDO/ThinkPHP scalar representation is not certified without PHP execution.

| Field | SQL type / DDL default | GET shape |
| --- | --- | --- |
| `id` | `mediumint(11)` / `AUTO_INCREMENT` | integer-like DB scalar; no explicit getInfo cast |
| `pid` | `INT(10)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `type` | `TINYINT(2)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `product_type` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `relation_id` | `INT(10)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `mer_id` | `int(10)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `image` | `varchar(256)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `recommend_image` | `varchar(256)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `slider_image` | `varchar(5000)` / `""` | array/mixed: see transformation table |
| `store_name` | `varchar(256)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `store_info` | `varchar(256)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `keyword` | `varchar(256)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `bar_code` | `varchar(15)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `cate_id` | `varchar(64)` / `""` | array/mixed: see transformation table |
| `price` | `decimal(12,2)` / `"0.00"` | number (explicit floatval) |
| `settle_price` | `DECIMAL(10,2)` / `"0.00"` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `vip_price` | `decimal(12,2)` / `"0.00"` | number (explicit floatval) |
| `ot_price` | `decimal(12,2)` / `"0.00"` | number (explicit floatval) |
| `delivery_type` | `varchar(255)` / `""` | array/mixed: see transformation table |
| `freight` | `tinyint(1)` / `"2"` | integer-like DB scalar; no explicit getInfo cast |
| `postage` | `decimal(12,2)` / `"0.00"` | number (explicit floatval) |
| `temp_id` | `int(11)` / `"1"` | integer-like DB scalar; no explicit getInfo cast |
| `unit_name` | `varchar(32)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `sort` | `smallint(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `star` | `DECIMAL(2,1)` / `"3.0"` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `collect` | `int(10)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `ficti` | `mediumint(11)` / `"100"` | integer-like DB scalar; no explicit getInfo cast |
| `sales` | `mediumint(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `stock` | `mediumint(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_show` | `tinyint(1)` / `"1"` | integer-like DB scalar; no explicit getInfo cast |
| `is_hot` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_benefit` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_best` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_new` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `add_time` | `int(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_postage` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_verify` | `TINYINT(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_del` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `mer_use` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `give_integral` | `decimal(12,2)` / `"0.00"` | number (explicit floatval) |
| `cost` | `decimal(12,2)` / `"0.00"` | number (explicit floatval) |
| `is_seckill` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_bargain` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_good` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_sub` | `tinyint(1)` / `"0"` | array/mixed: see transformation table |
| `is_vip` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `browse` | `int(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `code_path` | `varchar(64)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `soure_link` | `varchar(2000)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `video_open` | `TINYINT(1)` / `"0"` | boolean (explicit cast) |
| `video_link` | `varchar(500)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `spec_type` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `activity` | `varchar(255)` / `""` | array/mixed: see transformation table |
| `spu` | `char(13)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `label_id` | `varchar(64)` / `""` | array/mixed: see transformation table |
| `command_word` | `varchar(255)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `recommend_list` | `varchar(256)` / `""` | array/mixed: see transformation table |
| `brand_id` | `int(11)` / `"0"` | array/mixed: see transformation table |
| `brand_com` | `varchar(64)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `code` | `varchar(50)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `is_vip_product` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_presale_product` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `presale_start_time` | `int(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `presale_end_time` | `int(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `presale_day` | `int(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `auto_on_time` | `int(11)` / `"0"` | string: empty or Shanghai YYYY-MM-DD HH:mm:ss |
| `auto_off_time` | `int(11)` / `"0"` | string: empty or Shanghai YYYY-MM-DD HH:mm:ss |
| `custom_form` | `longtext` / `NULL` | array/mixed: see transformation table |
| `system_form_id` | `INT(10)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_support_refund` | `tinyint(1)` / `"1"` | integer-like DB scalar; no explicit getInfo cast |
| `store_label_id` | `longtext` / `NULL` | array/mixed: see transformation table |
| `ensure_id` | `longtext` / `NULL` | array/mixed: see transformation table |
| `specs` | `longtext` / `NULL` | array/mixed: see transformation table |
| `specs_id` | `int(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_limit` | `tinyint(1)` / `"0"` | boolean (explicit cast) |
| `limit_type` | `tinyint(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `limit_num` | `int(11)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `refusal` | `varchar(255)` / `""` | string or nullable/raw DB scalar; no explicit getInfo cast |
| `is_police` | `TINYINT(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |
| `is_sold` | `TINYINT(1)` / `"0"` | integer-like DB scalar; no explicit getInfo cast |

Installer main table is pinned by S07; accessor behavior by S06. `tao_words` has no main column in this installer/current TS schema and GET does not fabricate it. `supplier_id`, `coupon_ids`, `header` are not source GET stored fields: Vue derives/replaces them.

Detailed transforms:

- `is_sub` — number[]. Append 1 iff stored is_sub==1, then append 0 iff is_vip==1; [] otherwise. Stored is_vip stays in DTO. [S03]
- `recommend` — []. Always empty; not read from a column. [S03]
- `cost, give_integral, ot_price, postage, price, vip_price` — number. Explicit floatval conversions. settle_price and star are NOT converted by getInfo. [S03]
- `video_open, is_limit` — boolean. Explicit boolean conversion. [S03]
- `slider_image` — string[] or null in malformed/empty legacy JSON. Model json_decode on any string; non-string returns[]. Empty stored string decodes null, not[]. [S06]
- `delivery_type` — string[]. Truthy CSV splits; falsey returns[]. [S06]
- `cate_id` — string[] or original array. No category lookup or parent expansion: explode comma if not array. Empty CSV yields [""]. [S03]
- `brand_id` — number[]. brand_com split+intval; [] if empty. Stored leaf brand_id is discarded even if positive when brand_com empty. brand_com remains raw. [S03]
- `coupons` — {title:string,id:integer-like}[]. Product coupon relation issue_coupon_id -> StoreCouponIssue title,id. No is_del/status/date filter, no preserved relation snapshot title, unspecified order. [S21]
- `label_id` — {id:integer-like,label_name:string}[]. Main CSV/model integer IDs -> selected user label rows ordered idDESC; missing labels vanish. No owner filter in this lookup. [S19]
- `store_label_id` — {id:integer-like,label_name:string}[]. Main accessor integer IDs -> selected product-label id/name rows. No status/owner filter or explicit sort in getInfo. [S03]
- `ensure_id` — number[]. Model CSV int/array_filter accessor only; empty=>[]. No ensure lookup. [S06]
- `specs` — array/mixed|null. Persisted JSON snapshot decoded by model, falsey=>[]; not replaced from current template. specs_id remains persisted integer-like scalar. [S06]
- `presale_time` — [] or [string,string]. Only checks presale_start_time==0; otherwise formats both endpoints in source timezone, even end0 (1970-01-01 08:00:00). [S03]
- `auto_on_time, auto_off_time` — string. auto_on_time hidden when is_show truthy; auto_off_time hidden when is_show falsey; other nonzero timestamps format Y-m-d H:i:s, else empty. [S03]
- `video_link` — string. If nonempty and strpos(value,"http")===false, prefix site_url literally; this is not a URL parser/origin policy. [S03]
- `description` — string. Read separate product_id,type0 description, htmlspecialchars_decode once; missing=>empty. Current TS saves raw HTML, so do not blindly decode new TS rows again. [S22]
- `custom_form, custom_form_info` — array. Unconditionally resets both to[]. If system_form_id, fetch current system_form.value by id regardless status, decode it, and derive compact info via handleForm. Ignores persisted product.custom_form. [S03]
- `activity` — string[]. Nonempty CSV retains order: 0默认,1秒杀,2砍价,3拼团; other values passthrough. Empty=>all four default captions. [S03]
- `recommend_list` — {product_id:string,image:string}[]. Main CSV order preserved; image lookup by productid without visibility/delete filter; missing=>empty image. Empty=>[]. [S03]

## SKU read shapes and hidden mutation

For spec_type=1, source reads attr_result JSON (not a fresh full SKU projection), appends value1..N by iterating each row.detail in object order, sets items=result.attr, attrs=result.value, and attr to the empty batch placeholder below. No normalisation of all snapshot numeric types occurs in this branch. The raw JSON can contain virtual_list/disk_info from the historical save. [S03,S08,S09]

```json
{
  "pic": "",
  "vip_price": 0,
  "price": 0,
  "settle_price": 0,
  "cost": 0,
  "ot_price": 0,
  "stock": 0,
  "bar_code": "",
  "weight": 0,
  "volume": 0,
  "brokerage": 0,
  "brokerage_two": 0,
  "code": "",
  "write_times": 1,
  "write_valid": 1,
  "days": 0,
  "section_time": []
}
```

For spec_type!=1, items=[] and attrs=[]. `attr` comes from an unspecified first ordinary SKU (no order and no retired concept in PHP): pic=image; vip_price/price/settle_price/cost/ot_price/stock/weight/volume/brokerage/brokerage_two as numeric floats default0; bar_code/code as strings defaultempty; disk_info raw or[]; write_times/write_valid int default1; days=write_days??days??0; section_time=[Shanghai date-only start or empty,end or empty]. It does not include stable id/unique/suk/detail/sales/sum_stock in attr. [S03]

Critical source bug: single attr.virtual_list calls getArr(isset(result.unique),id), passing boolean rather than unique. getArr itself queries by attr_unique and product_id and returns plaintext {key:card_no,value:card_pwd} without uid/order restriction. Do not interpret the often-empty bool lookup as a security guarantee or correct it by leaking all assigned cards. The later generator(0) uses the real unique and does expose that full plaintext list. [S03,S10]

Before either SKU branch, checkProductAttr runs. If the result is missing/falsey, it constructs default 规格/默认 from main prices/image/stock, validates, writes dimensions/result/SKUs through positional saveProductAttr, and updates main.spec_type=0. It catches and ignores every Throwable. saveProductAttr can overwrite existing rows by position and delete excess rows, so this is much more than a harmless default formatter. For a missing multi snapshot, local productInfo may still retain the old spec_type=1 after the database changes to0. [S09,S08]

Recommended read-only alternative:

- Complete valid active SKU/dimension rows are the authority. Rebuild a bounded projection in memory, preserving real stable SKU IDs/unique and explicit retirement boundaries; verify the old/TS result JSON only as a snapshot. Do not return current TS camel/image/string-money snapshots directly as old pic/snake/numeric attrs.
- No rows should produce a clearly marked unpersisted editor template or repair-needed state with no invented unique; full authorized save/repair must create identities. Inconsistent/duplicate/partial Cartesian data should produce a controlled refusal instead of a hidden destructive repair. Reconstructing a missing snapshot does not require writing it.
- Exclude card passwords from ordinary editor reads. Return virtual_list=[] plus available/assigned counts, preserve existing stock through the current server baseline, and offer the separate governed inventory/export path.
- Fixed disk_info is separate from the import list. Redacting it to empty without a preserve contract would make a normal whole-form resave switch delivery mode/erase contents. Either permit its explicit read only to current managers (viewers receive masked configuration metadata) or add a verified preserve-unchanged write contract first. Copy always strips both fixed and inventory secrets and resets inventory-backed stock to0.
- Keep retired rows out of active attrs and expose a separate bounded retired projection if the editor lifecycle UI needs it; do not resurrect them via normal save.

## Custom form formatter

The GET unconditionally replaces persisted product.custom_form, even when system_form_id=0. With a template ID, it reads current template.value without source status/is_del filtering; malformed JSON may yield null and fail handleForm(array). Target must explicitly choose exact source reset semantics versus preserving the saved product form snapshot. Silently defaulting to[] loses full-form information. [S03,S12]

handleForm yields id,type,name,title,tip,list,require,value per field. Captions: {"checkboxs": "多选框", "citys": "城市", "dates": "日期", "dateranges": "日期范围", "radios": "单选框", "selects": "下拉框", "texts": "文本框", "times": "时间", "timeranges": "时间范围", "uploadPicture": "图片"}. list comes from wordsConfig.list only for checkboxs/radios/selects; require uses titleShow.val with false fallback. Other values have empty fallback as recorded in JSON.

## New-form defaults and real consumer dependencies

The following is Vue local formValidate state, not GET data, and intentionally differs from SQL defaults (e.g. freight1 versus DDL2; ficti0 versus DDL100; refund0 versus DDL1; limit_type/limit_num1 while disabled; presale_day1 versus DDL0). [S25]

```json
{
  "system_form_id": 0,
  "is_presale_product": 0,
  "is_limit": 0,
  "limit_type": 1,
  "limit_num": 1,
  "is_vip_product": 0,
  "is_support_refund": 0,
  "disk_info": "",
  "presale_day": 1,
  "presale_time": [],
  "auto_on_time": "",
  "video_open": false,
  "store_name": "",
  "freight": 1,
  "postage": 0,
  "custom_form": [],
  "cate_id": [],
  "label_id": [],
  "ensure_id": [],
  "keyword": "",
  "unit_name": "",
  "specs_id": 0,
  "store_info": "",
  "bar_code": "",
  "code": "",
  "image": "",
  "recommend_image": "",
  "slider_image": [],
  "description": "",
  "ficti": 0,
  "give_integral": 0,
  "sort": 0,
  "is_show": 1,
  "is_hot": 0,
  "is_benefit": 0,
  "is_best": 0,
  "is_new": 0,
  "is_good": 0,
  "is_postage": 0,
  "is_sub": [],
  "id": 0,
  "spec_type": 0,
  "video_link": "",
  "temp_id": "",
  "attrs": [],
  "items": [
    {
      "pic": "",
      "price": 0,
      "cost": 0,
      "ot_price": 0,
      "stock": 0,
      "bar_code": "",
      "code": ""
    }
  ],
  "activity": [
    "默认",
    "秒杀",
    "砍价",
    "拼团"
  ],
  "couponName": [],
  "header": [],
  "selectRule": "",
  "coupon_ids": [],
  "command_word": "",
  "delivery_type": [
    "1"
  ],
  "specs": [],
  "recommend_list": [],
  "brand_id": [],
  "product_type": 0
}
```

Initial oneFormValidate[0] is separate:

```json
{
  "pic": "",
  "price": 0,
  "settle_price": 0,
  "cost": 0,
  "ot_price": 0,
  "stock": 0,
  "bar_code": "",
  "code": "",
  "weight": 0,
  "volume": 0,
  "brokerage": 0,
  "brokerage_two": 0,
  "vip_price": 0,
  "virtual_list": [],
  "write_times": 0,
  "write_valid": 1,
  "days": 1
}
```

auto_off_time is not in the shown initial literal; it is assigned by the date-change handler/GET. supplier_id is commented out in the initial literal, and store_label_id is supplied on GET/submission via storeDataLabel. The independent component type property starts0.

infoData immediately replaces formValidate with the whole DTO; converts cate_id to numbers, brand_id to strings; maps coupon rows to coupon_ids; sets supplier_id=data.relation_id (then nonphysical productTypeTap resets supplier_id/postage to0); copies description into editor contents; binds labels, store labels, specs and custom_form_info; wraps attr into oneFormValidate; empties header and invokes generate(0), then seeds many rows from attrs. It uses strict spec_type===0, so this must be a numeric scalar. is_limit becomes0/1; limit_type/refund are parsed. [S25]

generate(0) is a real second POST to product/generate_attr/formValidate.id/0 with attrs dimensions and product_type. It loads info.header/info.attr/info.value, updates header/table/marketing columns, and can replace the just-loaded GET attrs asynchronously. Existing source type0 drops nonexistent combinations; type1 makes blank rows; header includes supplier settlement, physical dimensions/card actions. Thus GET alone cannot make the old editor usable while this dependency is absent. [S02,S03,S24,S25]

Other independent dependencies: category cascader, rule templates get_rule, owner-sensitive get_template?id, supplier list, brand tree (client stringifies values recursively), units, ensure/spec templates, allSystemForm and systemFormInfo preview, upload type/temp keys, ERP config, draft/cache, check_activity before changing/removing SKU shapes, asset picker/uploader. Creating a category uses productCreateApi, not the product GET. Date-only/second-card section_time uses source Asia/Shanghai; formatRichText modifies image HTML only at submit, not as a GET sanitiser. [S25,S24,S02,S26]

## Chosen implementation contract

The parent implementer has selected: reject ID0/missing; RR READ ONLY with live product.view/exact620; persisted main associations (no stale relation union); real active ordinary SKU/dimension projection; unpersisted main default only for single/no-SKU; ambiguous topology409; no historical card credentials or snapshot virtual_list; aggregate inventory counts. Actual fixed disk_info remains readable under the existing modern product.view detail boundary, so whole-form saves retain it. This deliberately preserves that existing access boundary; it is not a secret-redacted fixed-content contract. custom_form follows current source template, with a separate stored_custom_form snapshot extension. Trusted copying remains a later HTTP/UI task.

The manager-only/preserve-token alternatives above are design alternatives, not an additional gate imposed on this selected product.view contract. No current copy completion is claimed.

## Recommended full target projection and verification

- Use one current-authority repeatable-read READ ONLY transaction, complete bounded SQL reads and final database clock expiry. Preserve the full row plus every derived legacy key, rather than returning the existing modern flat detail DTO. Source seed620/product.view binds this route; manage grants can be consulted separately for protected fixed-content access.
- Keep source GET0 missing-row behavior; create UI uses local/draft defaults and selectors. Support existing deleted/hidden products under source detail read authority; modern detail isDel rejection is not this contract.
- Return platform tempList/cateList as source; keep the separate owner-sensitive selectors independent. Strict cap+overflow refusal beats silently truncating 500 rows. Include historical selected IDs where a display-only disabled entry is needed, and do not silently prune saved form/spec fields.
- Map all source snake main fields, CSV IDs/JSON/date/numeric/bool transforms, coupons/labels/recommend images, ordinary single/multi SKUs and form metadata explicitly. Add stable SKU identity/count/retired/repair flags as documented target extensions, not as substitutes for source fields.
- Verify private slider/main/SKU/recommend/description assets under their actual owner in the snapshot and sign only permitted outgoing URLs. Current TS save stores raw editable HTML while PHP escaped on write/decoded on read: establish provenance/normalization; do not repeatedly html-decode or publish-sanitize the editor source.
- Require source helper->App/JWT/SQL tests for positive ID, zero/missing, source seed620 versus wrong identities, hidden/deleted/owner scope, every field transform, source+TS snapshots, single/multi/type4/cards/fixed content, form snapshots, metadata overflow, malformed/ambiguous state, no hidden writes under SELECT-only role, one consistent snapshot and final DB-clock expiry. Full UI/copy/browser proof remains separate.

## Pinned source references

- **S01** `/home/cina/cinagroup/cinashop-php/route/admin.php` lines 1533-1536, 1562-1577; SHA-256 `8350eca9e328ed615cea117089589274d7e262324b979af588a714415f522652`. True GET/POST/generate/template contracts within product group
- **S02** `/home/cina/cinagroup/cinashop-php/app/controller/admin/v1/product/StoreProduct.php` lines 491-494, 599-621, 679-722; SHA-256 `c25566e19ed22fdec15380467996f821f4f57a38ea915a39599404e962c6ba60`. get_product_info has no creation defaults; generator/template owner dispatch
- **S03** `/home/cina/cinagroup/cinashop-php/app/services/product/product/StoreProductServices.php` lines 343-493, 502-707; SHA-256 `edf89202f65c2f6b161dbbccdb7cc68ef6270ae31c11afe91ab26aa285722943`. Complete getInfo transformation and subsequent generator called by old Vue
- **S04** `/home/cina/cinagroup/cinashop-php/app/dao/product/product/StoreProductDao.php` lines 233-236; SHA-256 `2cdc901c673a11e699a23bd2d4ddcd01abe108d10854ddd3588099ec712ec5e8`. find(id) with coupons; no owner/is_del/status restriction
- **S05** `/home/cina/cinagroup/cinashop-php/app/dao/BaseDao.php` lines 383-391; SHA-256 `43fd77897402aed4ccf5f3504251df696ccc8ab4a1decdc6c1054ecb208ea603`. search([]) returns unfiltered model
- **S06** `/home/cina/cinagroup/cinashop-php/app/model/product/product/StoreProduct.php` lines 46-132, 221-224, 259-262; SHA-256 `696b6b6601e9ba8ba9fcde26a4ed12bda7f98edaaa81fc72ced3cae5321dc1a9`. CSV/JSON accessors and coupons relation
- **S07** `/home/cina/cinagroup/cinashop-php/public/install/crmeb.sql` lines 2682-2763; SHA-256 `0096d86464b81935106311e4bb4092b647ab3acaf2bab0febe5695f8f66c593a`. All original main-row storage columns, types and DDL defaults
- **S08** `/home/cina/cinagroup/cinashop-php/app/services/product/sku/StoreProductAttrServices.php` lines 80-220, 223-272; SHA-256 `dae3878db9eb0392b01f52c5db1d8ba1cbf35456a9ddb081150a1955f87b0de9`. validate shape, result snapshot and destructive positional save invoked by implicit GET repair
- **S09** `/home/cina/cinagroup/cinashop-php/app/services/product/sku/StoreProductAttrResultServices.php` lines 40-43, 68-80, 88-153; SHA-256 `136d66730ba803a8a4748edb3fd33f3c0b610556c466ddad6bde9f383704a9a1`. JSON result and hidden checkProductAttr writes; Throwable is swallowed
- **S10** `/home/cina/cinagroup/cinashop-php/app/services/product/sku/StoreProductVirtualServices.php` lines 32-40, 66-109; SHA-256 `1a44c129483d02f79b0f70f972fd5954b543eb7afb246a9e083de99e887613a1`. Plaintext card lookup without uid restriction and original import semantics
- **S11** `/home/cina/cinagroup/cinashop-php/app/model/product/sku/StoreProductAttrValue.php` lines 43-61; SHA-256 `5f314d6aa61ea7cbf86803616cb49e948b441d9c69dd09a6f78e6ed54de2366d`. Historical unique preserved or new hex8 generated
- **S12** `/home/cina/cinagroup/cinashop-php/app/services/system/form/SystemFormServices.php` lines 34-45, 76-104; SHA-256 `7592c22bef6da315a09de29faa698fb3796c244e8286bb1bdbf215a30ff065c1`. Form type captions and compact custom_form_info formatter
- **S13** `/home/cina/cinagroup/cinashop-php/app/dao/product/shipping/ShippingTemplatesDao.php` lines 41-44; SHA-256 `63c136db110d7e3f860a4d006aeb8ca8174e9c0057612aaa84faabf76e55828e`. getTemp scoped type/relation, sort DESC,id DESC, id/name rows
- **S14** `/home/cina/cinagroup/cinashop-php/app/model/product/shipping/ShippingTemplates.php` lines 124-158; SHA-256 `d99c89897b6a4bc3191193da0a87d963044948246983a2ab5266c5aba3dbd529`. Scope searchers do not add live status/is_del predicates
- **S15** `/home/cina/cinagroup/cinashop-php/app/services/product/category/StoreProductCategoryServices.php` lines 128-139; SHA-256 `77431e2d9eebeb2b85eff500f7bde1ed9359f3da801513f719b6a9080c1ad41e`. Platform shown category tree via value/label/pid rows
- **S16** `/home/cina/cinagroup/cinashop-php/app/dao/product/category/StoreProductCategoryDao.php` lines 63-66; SHA-256 `996bdc89810d1c70bc612fd2b5c5321b4cd0df143fa36da2470ddfbfbda0a4f0`. Category sibling input order sort DESC,id DESC
- **S17** `/home/cina/cinagroup/cinashop-php/app/model/product/category/StoreProductCategory.php` lines 119-140, 180-184; SHA-256 `237edefa1695e83664199b9f28101c0f08cd257ed45432024c335f1c180b62b5`. level=-1 all levels; is_show=1 selector
- **S18** `/home/cina/cinagroup/cinashop-php/app/services/user/label/UserLabelServices.php` lines 60-63; SHA-256 `a3880e5910f14f0611270ba70c5c34fb2e175fccd45213045c581a55cc46847f`. Selected user labels without pagination
- **S19** `/home/cina/cinagroup/cinashop-php/app/dao/user/label/UserLabelDao.php` lines 46-51; SHA-256 `b5931134b210328e52dfe195120e138c50c808b8d449d75a057d8dee7dae0ea0`. Label order id DESC
- **S20** `/home/cina/cinagroup/cinashop-php/app/model/user/label/UserLabel.php` lines 80-83; SHA-256 `22e3978b4d3c5e05e83292cf93ba2efc883815050cca08aab38fb3342c2a55b9`. ids IN search
- **S21** `/home/cina/cinagroup/cinashop-php/app/dao/activity/coupon/StoreCouponIssueDao.php` lines 386-389; SHA-256 `d216691392c2ffb14b70ca76eaf5dc4d1fdd2b512bf98fb5774020427f1f26ea`. Selected issue title,id, no status/expiry/delete scope filter
- **S22** `/home/cina/cinagroup/cinashop-php/app/services/product/product/StoreDescriptionServices.php` lines 38-43, 52-65; SHA-256 `ba4f5434c0d76432fe962eac2f8f8cca233753c6259438fbc018b80224094acd`. Decode description on read, htmlspecialchars on legacy write
- **S23** `/home/cina/cinagroup/cinashop-php/app/dao/product/product/StoreDescriptionDao.php` lines 40-43; SHA-256 `8fbe9fc7c6f0533e19bc21c434b2b20abf7f01cf989012f0fe42c19644223e11`. Description by product_id,type; absent becomes empty
- **S24** `/home/cina/cinagroup/cinashop-php/view/admin/src/api/product.js` lines 125-140, 170-175, 272-278, 332-380; SHA-256 `54d74b9804719d3e35d3eb9942c76af886a1cf9dc12f8204adb9e9e0ddc72e42`. productInfoApi is GET product/product/id; productEditApi edits category
- **S25** `/home/cina/cinagroup/cinashop-php/view/admin/src/pages/product/productAdd/index.vue` lines 2498-2596, 2774-2894, 2993-3042, 3252-3279, 3422-3496, 3763-3776, 3867-3909, 4008-4033, 4158-4175, 4225-4262, 4371-4398; SHA-256 `3146b4167f07bdcdd5f996be46a1e7f7801465e8b06c7afdfa81543dcea7019f`. True defaults, getInfo/infoData, generate dependency and copy/full-post behavior
- **S26** `/home/cina/cinagroup/cinashop-php/config/app.php` lines 38-38; SHA-256 `2fb949c2609d813c05ae974aef4379957decc2be6ad56d56be822c264820cfb3`. Source configured Asia/Shanghai date formatting
- **S27** `/home/cina/cinagroup/cinashop-php/view/admin/src/pages/product/productAdd/mixins/index.js` lines 1-111; SHA-256 `cb63f3c5d51d344d77b613279e55373763741fa37dbfcf13e77eff24dd289d44`. Client validation and Date-based schedule picker helpers; no GET API remapping
