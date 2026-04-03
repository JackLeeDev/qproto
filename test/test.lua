local qproto = require "qproto"

local function eq(a, b)
    local ta = type(a)
    local tb = type(b)
    if ta ~= tb then
        return false
    end
    if ta ~= "table" then
        return a == b
    end
    for k,v in pairs(a) do
        if not eq(v, b[k]) then
            return false
        end
    end
    for k,v in pairs(b) do
        if not eq(v, a[k]) then
            return false
        end
    end
    return true
end

local function assert_eq(a, b, typ, field)
    local desc = string.format("type %-15s field %-20s test ", typ, field)
    local ok = eq(a, b)
    if ok then
        print(desc .. "success")
    else
        error(desc .. "fail")
    end
end

local function assert_field_eq(msg1, msg2, typ, field)
    assert_eq(msg1[field], msg2[field], typ, field)
end

function load_proto()
    local f = io.open("../cfg/proto/All.proto", "r")
    local ctx = f:read("*a")
    f:close()
    local version = qproto.parse(ctx)
    qproto.save(version)
    qproto.reload()
end

function run_test()
    load_proto()    
    
    local msg = {
        reqInt = 101,
        reqIntArray = {101,102},
        reqString = "str",
        reqStringArray = {"str1", "str2", "str3"},
        reqBinary = "binary",
        reqBinaryArray = {"binary1", "binary2", "binary3", "binary4"},
        reqDouble = 1.23,
        reqDoubleArray = {1.2, 3.4, 5.6, 7.8},
        reqStruct = {testInt = 200},
        reqStructArray = {{testInt = 300}, {testInt = 600}},
        reqInnerStruct = {testInt = 700},
        reqInnerStructArray = {{testInt = 800}, {testInt = 900}}
    }
    local ptr,sz = qproto.encode_request("TestTypes", msg, 200)
    local id,deMsg,session,dest = qproto.decode_request(ptr)

    print("------------------ run tests ------------------\n")

    assert_eq(msg, deMsg, "integer", "reqInt")
    assert_eq(msg, deMsg, "integer*", "reqIntArray")

    assert_eq(msg, deMsg, "string", "reqString")
    assert_eq(msg, deMsg, "string*", "reqStringArray")

    assert_eq(msg, deMsg, "bytes", "reqBinary")
    assert_eq(msg, deMsg, "bytes*", "reqBinaryArray")

    assert_eq(msg, deMsg, "double", "reqDouble")
    assert_eq(msg, deMsg, "double*", "reqDoubleArray")

    assert_eq(msg, deMsg, "struct", "reqStruct")
    assert_eq(msg, deMsg, "struct*", "reqStructArray")

    assert_eq(msg, deMsg, "inner_struct", "reqInnerStruct")
    assert_eq(msg, deMsg, "inner_struct*", "reqInnerStructArray")

    assert_eq(session, 200, "session", "none")
    assert_eq(dest, "global.test", "forward-address", "none")

    print("\n--------------- tests completed ---------------")
end

run_test()
