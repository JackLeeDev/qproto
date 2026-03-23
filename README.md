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

# Test 100 million times(Intel(R) Core(TM) i5-13400F):

| Protocol   | Encoded Size | Encode Time | Decode Time | Total Time |
|------------|-------------:|------------:|------------:|-----------:|
| **sproto** | 29 bytes     | 840 ms      | 1950 ms     | 2790 ms    |
| **qproto** | 30 bytes     | **512 ms**      | **788 ms**      | **1300 ms** |
