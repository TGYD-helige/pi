# Seedance public material library

Source: [Volcengine Seedance 2.0 experience center](https://exp.volcengine.com/ark/gen_video?model=doubao-seedance-2-0-260128), **素材库**.

Observed on 2026-08-24. The Asset IDs below were copied directly from each
material card's **ID** button; they were not inferred from labels or media URLs.
The catalog may change independently of the API. It currently contains 71
images, 36 videos, and 80 audio samples. The separate **虚拟人像库** is not
duplicated here; search it through the persona workflow in [trusted portraits](../SKILL.md#a2-seedance-trusted-portraits-and-provider-managed-assets).

## Selection contract

1. Use this file when the user wants a built-in public image, action, camera
   move, visual style, environment, character, or sample voice.
2. Put the selected value below into `referenceAssets[].assetId` unchanged,
   with the matching `image`, `video`, or `audio` modality. The extension
   normalizes it to Ark's `asset://...` request form.
3. These IDs prove what the observed experience-center account returned on
   the observation date; Volcengine does not document them here as permanent
   or cross-account identifiers. If the active account rejects one, reopen
   the current experience center and copy that card's ID again.
4. Keep duplicate labels distinct. The video library has two entries named
   `仰卧起坐`; select them by their different Asset IDs.
5. Preserve modality order. In prompt prose refer to attachments as `Image 1`,
   `Video 1`, or `Audio 1`, never by Asset ID.
6. Do not reuse these public-material IDs as preset-avatar IDs. For a
   recognizable real person, follow [trusted portraits](../SKILL.md#a2-seedance-trusted-portraits-and-provider-managed-assets) and obtain a current-account trusted
   portrait or preset-avatar Asset ID from the user.

Example:

```json
{
  "referenceAssets": [
    { "modality": "image", "assetId": "asset-..." },
    { "modality": "video", "assetId": "asset-..." },
    { "modality": "audio", "assetId": "asset-..." }
  ]
}
```

## Images (71)

### Clothing — 服饰 (17)

| Display label | Asset ID |
|---|---|
| 东北大花袄 | `asset-20260224190652-2qjpm` |
| 云锦马褂 | `asset-20260224190652-gjxrs` |
| 前卫时尚装 | `asset-20260224190652-qh7jl` |
| 卫衣 | `asset-20260224190652-xpr4v` |
| 太空服 | `asset-20260224190652-6g4vg` |
| 旗袍 | `asset-20260224190652-sp4wk` |
| 校服 | `asset-20260224190652-zqllz` |
| 毛衣 | `asset-20260224190652-5nqsp` |
| 汉服 | `asset-20260224190652-qbgxp` |
| 波西米亚装 | `asset-20260224190652-kpb7f` |
| 洛丽塔装 | `asset-20260224190652-n8sd2` |
| 洛可可装 | `asset-20260224190652-n8g6z` |
| 港风服装 | `asset-20260224190652-xjqsq` |
| 牛仔装 | `asset-20260224190652-4ww76` |
| 童装 | `asset-20260224190652-xcjwr` |
| 西装 | `asset-20260224190652-lgzsw` |
| 黑暗哥特装 | `asset-20260224190652-9hcbf` |

### Environments — 环境 (18)

| Display label | Asset ID |
|---|---|
| 中式宫廷 | `asset-20260224190652-wcjmn` |
| 元宇宙锚点站台 | `asset-20260224190652-b89h7` |
| 北极冰屋画廊 | `asset-20260224190652-g2xn9` |
| 印第安星空剧场 | `asset-20260224190652-xf7sd` |
| 古祠银杏书屋 | `asset-20260224190652-ch6g5` |
| 埃及沙漠书店 | `asset-20260224190652-p62jn` |
| 无人便利店迷宫 | `asset-20260224190652-vpdzh` |
| 星云穿梭机 | `asset-20260224190652-kgm2p` |
| 榫卯古城防御战 | `asset-20260224190652-hgjcj` |
| 毛茸茸耶耶之家 | `asset-20260224190652-kc7cz` |
| 潮汐实验室 | `asset-20260224190653-vxlbm` |
| 火山熔岩工厂 | `asset-20260224190652-lmt6v` |
| 蒸汽档案馆 | `asset-20260224190653-lx8xv` |
| 运河酒肆 | `asset-20260224190653-c8cbc` |
| 都市外卖海盗船 | `asset-20260224190653-bspwx` |
| 雾凇林海 | `asset-20260224190653-mxcs5` |
| 露天蓝冰洞 | `asset-20260224190653-kjptw` |
| 魔法直播间 | `asset-20260224190653-86wsc` |

### Visual styles — 画风 (18)

| Display label | Asset ID |
|---|---|
| 丙烯插画 | `asset-20260224190653-kt76l` |
| 体素风 | `asset-20260224190653-pshz6` |
| 像素风 | `asset-20260224190653-9trv8` |
| 印象派油画 | `asset-20260224190653-95mql` |
| 叙事插画 | `asset-20260224190653-8p42x` |
| 国漫 | `asset-20260224190653-m5cjp` |
| 折纸 | `asset-20260224190653-dpjsd` |
| 拼贴画报 | `asset-20260224190653-8wcxx` |
| 日漫 | `asset-20260224190653-tlgbc` |
| 欧美3D动画 | `asset-20260224190653-cmlmc` |
| 水墨 | `asset-20260224190653-wg4hr` |
| 水彩 | `asset-20260224190653-7cj2s` |
| 版画 | `asset-20260224190653-7p424` |
| 皮影戏 | `asset-20260224190653-hv2mt` |
| 简笔画 | `asset-20260224190653-87hrk` |
| 素描 | `asset-20260224190654-nv4db` |
| 线稿 | `asset-20260224190653-bsjpj` |
| 黏土风 | `asset-20260224190653-tjwpv` |

### Characters — 角色 (18)

| Display label | Asset ID |
|---|---|
| 剑穗松鼠侠 | `asset-20260224190653-ts8h4` |
| 古风小生 | `asset-20260224190654-fpcs4` |
| 围脖树懒君 | `asset-20260224190654-twfhw` |
| 塔罗占星者 | `asset-20260224190654-jcnvv` |
| 小伞蝾螈 | `asset-20260224190654-hhsz7` |
| 拖鞋柯基犬 | `asset-20260224190654-qqp65` |
| 月老 | `asset-20260224190654-p66c8` |
| 机车雪狼王 | `asset-20260224190654-vznsm` |
| 棉花糖羊驼 | `asset-20260224190654-r7spk` |
| 粽子宝宝 | `asset-20260224190654-m4mgr` |
| 精灵耳女孩 | `asset-20260224190654-rhkbk` |
| 绒帽鼠宝 | `asset-20260224190654-hcsf6` |
| 绒毛墨镜青蛙 | `asset-20260224190654-4xxp2` |
| 肚兜胖橘猫 | `asset-20260224190654-6dmkh` |
| 背带花猪猪 | `asset-20260224190654-cmgl4` |
| 财神 | `asset-20260224190654-mmlrk` |
| 钢爪猎鹰哥 | `asset-20260224190654-gtl8r` |
| 魔法帽小熊 | `asset-20260224190654-zf97b` |

## Videos (36)

### Actions — 动作 (18)

| Display label | Asset ID |
|---|---|
| 华尔兹 | `asset-20260224190654-hrc6j` |
| 仰卧起坐 (entry 1) | `asset-20260224190654-plxzb` |
| 仰卧起坐 (entry 2) | `asset-20260224190655-wh6q5` |
| 作揖 | `asset-20260224190654-sccrq` |
| 偷感很重 | `asset-20260224190654-dcmbc` |
| 勾手转圈圈 | `asset-20260224190654-rkfwp` |
| 打斗 | `asset-20260224190655-9vtsk` |
| 扭秧歌 | `asset-20260224190654-9nbbl` |
| 扮鬼脸 | `asset-20260224190654-hf5mv` |
| 投掷武器 | `asset-20260224190655-8q5f8` |
| 拥抱 | `asset-20260224190655-5r8fd` |
| 摇头扭胯 | `asset-20260224190655-7fkx2` |
| 比心 | `asset-20260224190655-rptx6` |
| 牵手带走 | `asset-20260224190655-gfv4h` |
| 狼吞虎咽 | `asset-20260224190655-8v44l` |
| 美式打招呼 | `asset-20260224190655-btnhx` |
| 跑酷跨栏 | `asset-20260224190655-sf8bz` |
| 跪地求饶 | `asset-20260224190655-lqs52` |

### Camera and transition references — 运镜 (18)

| Display label | Asset ID |
|---|---|
| FPV坠楼旋转俯冲 | `asset-20260224190655-67n7r` |
| POV到过肩镜头 | `asset-20260224190655-zzg8c` |
| RIG镜头 | `asset-20260224190655-b9w7v` |
| 产品摄影旋转 | `asset-20260224190655-zfgg6` |
| 子弹时间转场 | `asset-20260224190655-hjgxp` |
| 宠物儿童鱼眼镜头 | `asset-20260224190655-n8qw9` |
| 延时摄影 | `asset-20260224190655-7gsx7` |
| 微距镜头拉伸至广角 | `asset-20260224190655-95kps` |
| 手持摄影 | `asset-20260224190655-sflmb` |
| 无人机低飞追拍拉升 | `asset-20260224190655-xgrff` |
| 时空隧道 | `asset-20260224190655-bkdh9` |
| 焦点偏移 | `asset-20260224190655-kk469` |
| 焦距压缩 | `asset-20260224190655-4jrc8` |
| 物品飞出伸手接住 | `asset-20260224190656-69q5r` |
| 物品飞出变装转场 | `asset-20260224190656-5lqm4` |
| 特写转大全景 | `asset-20260224190656-xl9m7` |
| 英雄时刻 | `asset-20260224190656-7tx7w` |
| 镜面反射 | `asset-20260224190656-54sg9` |

## Audio samples (80)

Preview durations are the lengths shown by the experience center, not a
promise about generated-video duration.

| Display label | Preview | Asset ID |
|---|---:|---|
| 少年_少女-女-少儿故事 | 11.4s | `asset-20260224190656-dw78f` |
| 青年-女-流畅女声 | 8.5s | `asset-20260224190656-7nvns` |
| 青年-女-魅力女友 | 9.1s | `asset-20260224190656-qr992` |
| 青年-女-黑猫侦探社咪仔 | 11.7s | `asset-20260224190656-f5wvc` |
| 青年-女-鸡汤女 | 9.3s | `asset-20260224190656-8t7zs` |
| 青年-男-大壹 | 7s | `asset-20260224190656-tnphs` |
| 青年-男-儒雅逸辰 | 8.8s | `asset-20260224190656-7n7cg` |
| 青年-男-儒雅公子 | 6.3s | `asset-20260224190656-k9d7r` |
| 少年_少女-女-萌丫头 | 9.8s | `asset-20260224190656-mdwbp` |
| 青年-女-贴心女声 | 11.5s | `asset-20260224190656-ddltv` |
| 中年-女-鸡汤妹妹 | 11.9s | `asset-20260224190656-mcs77` |
| 少年_少女-男-亮嗓萌仔 | 5.7s | `asset-20260224190656-6g84r` |
| 儿童-男-懒音绵宝 | 3.7s | `asset-20260224190656-srtjr` |
| 青年-女-俏皮女声 | 8s | `asset-20260224190656-jtswz` |
| 中年-男-四郎 | 12.4s | `asset-20260224190656-hczx4` |
| 中年-男-广告解说 | 11.6s | `asset-20260224190656-tqq2h` |
| 儿童-女-樱桃丸子 | 9.6s | `asset-20260224190656-gz5kb` |
| 中年-女-武则天 | 14.9s | `asset-20260224190656-rb4s7` |
| 儿童-女-佩奇猪 | 10s | `asset-20260224190656-7r964` |
| 少年_少女-男-熊二 | 9.4s | `asset-20260224190656-mrbs2` |
| 青年-男-猴哥 | 15s | `asset-20260224190656-sq5tk` |
| 儿童-男-天才童声 | 13.1s | `asset-20260224190656-6gkjj` |
| 青年-女-温柔小雅 | 13s | `asset-20260224190656-zrb6k` |
| 青年-男-咆哮小哥 | 5.5s | `asset-20260224190656-q8n9n` |
| 青年-男-醇厚低音 | 11.2s | `asset-20260224190656-ld557` |
| 青年-女-倾心少女 | 4.1s | `asset-20260224190656-459nf` |
| 青年-女-文静毛毛 | 8.5s | `asset-20260224190656-pc9ns` |
| 青年-男-悠悠君子 | 8.1s | `asset-20260224190656-wbz44` |
| 中年-男-Noah | 7.1s | `asset-20260224190656-dqph5` |
| 青年-男-Xavier | 7.5s | `asset-20260224190656-k7px4` |
| 儿童-男-KevinMcCallister | 9.8s | `asset-20260224190656-kl5gf` |
| 老年-男-ClownMan | 9.7s | `asset-20260224190656-ccgx8` |
| 青年-男-Chucky | 9.2s | `asset-20260224190656-5rq88` |
| 青年-男-Jigsaw | 8.5s | `asset-20260224190656-qltvl` |
| 青年-男-Zayne | 8.9s | `asset-20260224190657-j7z55` |
| 青年-女-Charlie | 5.1s | `asset-20260224190657-qx2rl` |
| 青年-女-贴心妹妹 | 5.6s | `asset-20260224190657-6z7hn` |
| 青年-女-小何2.0 | 6.4s | `asset-20260224190657-558cg` |
| 青年-男-小天2.0 | 6.2s | `asset-20260224190657-nd59k` |
| 青年-男-云舟2.0 | 6.8s | `asset-20260224190657-kdxqk` |
| 青年-女-爽快思思 | 9.6s | `asset-20260224190657-jk6vd` |
| 青年-女-儿童绘本 | 11.1s | `asset-20260224190657-9lsgk` |
| 青年-女-温柔女神 | 9.7s | `asset-20260224190657-6kzhw` |
| 青年-女-暖阳女声 | 10.2s | `asset-20260224190657-fjfcj` |
| 青年-男-儒雅男友 | 4.6s | `asset-20260224190657-pljvq` |
| 少年_少女-男-炀炀 | 5s | `asset-20260224190657-bj5zq` |
| 青年-女-Vivi | 11.6s | `asset-20260224190657-4hks7` |
| 青年-男-解说小明 | 11.4s | `asset-20260224190657-dw6jj` |
| 青年-女-清新女声 | 10.9s | `asset-20260224190657-8tcfp` |
| 青年-女-Tina老师 | 9.9s | `asset-20260224190657-smk6c` |
| 少年_少女-男-温暖少年 | 6.8s | `asset-20260224190657-x2g8f` |
| 青年-男-温暖阿虎 | 5.8s | `asset-20260224190657-w9bjq` |
| 少年_少女-女-灿灿 | 6.3s | `asset-20260224190657-qm7zm` |
| 青年-男-温柔小哥 | 8.4s | `asset-20260224190657-dk6kj` |
| 青年-男-率真小伙 | 7.1s | `asset-20260224190657-qn26k` |
| 青年-男-活泼爽朗 | 5.4s | `asset-20260224190657-7dgr4` |
| 青年-男-开朗轻快 | 5.4s | `asset-20260224190657-t55r8` |
| 青年-女-温柔文雅 | 8.7s | `asset-20260224190657-tx5bj` |
| 青年-男-暖心体贴 | 5.8s | `asset-20260224190657-jjj56` |
| 青年-女-知性温婉 | 9.1s | `asset-20260224190657-79wft` |
| 中年-女-心灵鸡汤 | 13s | `asset-20260224190657-dtx47` |
| 青年-女-开朗姐姐 | 12.6s | `asset-20260224190657-hjk6p` |
| 青年-女-清澈梓梓 | 10.4s | `asset-20260224190657-dmrnn` |
| 青年-女-甜美小源 | 13.2s | `asset-20260224190657-kvrll` |
| 少年_少女-女-邻家女孩 | 10.4s | `asset-20260224190657-c25mw` |
| 青年-男-清爽男大 | 10.8s | `asset-20260224190657-zzv99` |
| 青年-女-知性女声 | 11.3s | `asset-20260224190658-8h2gv` |
| 青年-女-魅力苏菲 | 7.4s | `asset-20260224190657-4vxtg` |
| 青年-男-开朗学长 | 7s | `asset-20260224190658-wg7vs` |
| 青年-女-温柔白月光 | 6s | `asset-20260224190658-mwq8b` |
| 青年-女-贴心闺蜜 | 4.8s | `asset-20260224190658-l5jhn` |
| 青年-女-初恋女友 | 5.3s | `asset-20260224190658-mdd62` |
| 青年-女-纯澈女生 | 4s | `asset-20260224190658-xf6fq` |
| 青年-男-冷酷哥哥 | 8.8s | `asset-20260224190658-llks5` |
| 青年-男-快乐小东 | 12.7s | `asset-20260224190658-k8s4v` |
| 青年-男-阳光阿辰 | 6.4s | `asset-20260224190658-cfzpd` |
| 青年-女-知心姐姐 | 6.9s | `asset-20260224190658-7kss5` |
| 儿童-女-元气甜妹 | 6.5s | `asset-20260224190658-dbmhj` |
| 青年-男-机灵小伙 | 5.4s | `asset-20260224190658-wx5qt` |
| 青年-女-亲切女声 | 5.6s | `asset-20260224190658-9xwll` |
