# qproto  
**A lightweight and ultra-fast protocol library from quick engine**  
 
✨ **Core Features**  
- ⚡ **Lightweight core** (<1.2K) 
- 🚀 **Blazing-fast** (more faster than pbc)
- 🌐 **Smart routing** using `[node][service-address].[message]` addressing (e.g. `global.test.TestBag`)
- 🛰️ **rpc support** (use session) 

# Protocal:
```lua
message global.test.TestBag 1 {
    request {
        
    }
    response {
        struct Item {
            struct Props {
                integer atk = 0
                integer def = 1
            }
            integer itemId = 0
            integer itemNum = 1
            Props props = 2
        }
        Item* items = 0
    }
}
```

# Data:
```lua 
local msg = {
  items = {
      {itemId = 10001, itemNum = 1, name = "item1", props = {atk = 1, def = 1}},
      {itemId = 10002, itemNum = 1, name = "item2", props = {atk = 2, def = 2}},
  },
}

local buffer = qproto.encode_response("TestBag", msg)
local id,deMsg,session,dest = qproto.decode_response(buffer)
```

# Test 100w times(Intel(R) Core(TM) i5-13400F VMware):

| Protocol   | Encoded Size | Encode Time | Decode Time | Total Time |
|------------|-------------:|------------:|------------:|-----------:|
| **sproto** | 42 bytes     | 612 ms      | 1405 ms     | 2017 ms    |
| **pbc**    | 40 bytes     | 1574 ms     | 3092 ms     | 4666 ms    |
| **qproto** | 42 bytes     | **573 ms**      | **781 ms**      | **1354 ms** |
| **qproto.js**  | 42 bytes     | 1896 ms     | **531 ms**      | 2427 ms    |
