import json, urllib.request, time
IDS = {'ETH-USD':'ethereum','WETH-USD':'weth','XAUT-USD':'tether-gold','XPL-USD':'plasma',
       'WBTC-USD':'wrapped-bitcoin','GHO-USD':'gho'}
plan = json.load(open('.local/rebase-plan.json'))
stable = {'USDC-USD','EURC-USD'}
pairs = sorted({(a['symbol'], a['date']) for a in plan if a['symbol'] not in stable})
out = {}
for sym, date in pairs:
    cid = IDS.get(sym)
    if not cid: continue
    y,m,d = date.split('-')
    url = f"https://api.coingecko.com/api/v3/coins/{cid}/history?date={d}-{m}-{y}&localization=false"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                md = json.load(r).get('market_data')
                if md:
                    out[f"{sym}|{date}"] = md['current_price']['usd']
                    print(f"{sym} {date} = {md['current_price']['usd']}")
                    break
        except Exception as e:
            pass
        time.sleep(12)
    time.sleep(3)
json.dump(out, open('.local/hist-prices.json','w'), indent=1)
print('fetched', len(out), 'of', len(pairs))
