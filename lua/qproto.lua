local c = require "qproto.core"
local string = string
local pairs = pairs

local qproto = {}

local VERSION

local base_types = {
    integer = 0,
    double = 0, --integer extra
    boolean = 0, --integer extra2
    string = 1,
    bytes = 1, --string extra
    struct = 2,
}

local function syntax_assert(condition, pos)
    if not condition then
        error(string.format("syntax error at line:%d", pos) .. ", " .. debug.traceback())
    end
    return condition
end

local function read_normal_field(objects, fields, content, pos, is_array, namespace)
    local field_type,name,field_id = content:match("%s*([%w_]+)%s+([%w_]+)%s*=%s*(%d+)%s*")
    syntax_assert(field_type, pos)
    syntax_assert(name, pos)
    field_id = syntax_assert(tonumber(field_id), pos)
    syntax_assert(field_id >= 0, pos)
    if fields[name] then
        error(string.format("duplicate field name '%s' at line:%d", name, pos))
    end
    for _,field in pairs(fields) do
        if field.id == field_id then
            error(string.format("duplicate field id '%d' at line:%d", field_id, pos))
        end
    end
    local extra = 0
    if field_type == "double" or field_type == "bytes" then
        extra = 1
    elseif field_type == "boolean" then
        extra = 2
    end
    local field = {
        id = field_id,
        name = name,
        is_array = is_array,
        type = nil,
        object = nil,
        object_names = nil,
        extra = extra,
        pos = nil,
    }
    if base_types[field_type] then
        field.type = base_types[field_type]
    else
        field.type = base_types.struct
        field.object_names = {}
        local prefix = ""
        for part in string.gmatch(namespace,  "[^_]+") do
            prefix = prefix == "" and part or prefix .. "_" .. part
            table.insert(field.object_names, 1, prefix .. "_" .. field_type)
        end
        table.insert(field.object_names, field_type)
        field.pos = pos
    end
    fields[name] = field
end

local function read_array_field(objects, fields, content, pos, namespace)
    content = content:gsub("*", "", 1)
    read_normal_field(objects, fields, content, pos, 1, namespace)
end

local function is_empty(str)
    return not str:find("%S")
end

local function is_begin_tag(str)
    return str:match("%s*{%s*") ~= nil
end

local function is_tag(lines, pos, func)
    while pos <= #lines do
        local content = lines[pos]
        if not is_empty(content) then
            syntax_assert(func(content), pos)
            return pos + 1
        else
            pos = pos + 1
        end
    end
    syntax_assert(false, pos)
end

local function read_begin_tag(lines, pos)
    return is_tag(lines, pos, is_begin_tag)
end

local function is_close_tag(str)
    return str:match("%s*}%s*") ~= nil
end

local function read_close_tag(lines, pos)
    return is_tag(lines, pos, is_close_tag)
end

local function read_field(objects, fields, content, pos, namespace)
    if is_empty(content) then
        return false
    elseif is_close_tag(content) then --close tag for object or message
        return true
    end
    if content:find("*") then
        read_array_field(objects, fields, content, pos, namespace)
    else
        read_normal_field(objects, fields, content, pos, 0, namespace)
    end
    return false
end

local function read_struct(lines, objects, messages, pos)
    local next_pos
    local content = lines[pos]
    local name = content:match("struct%s+([%w_]+)%s+{%s*")
    if name then
        next_pos = pos + 1
    else
        name = content:match("struct%s+([%w_]+)%s*$")
        syntax_assert(name, pos)
        next_pos = read_begin_tag(lines, pos + 1)
    end
    if objects[name] then
        error(string.format("duplicate object name '%s' at line %d", name, pos))
    end
    local object = {
        name = name,
        fields = {},
        cobject = nil,
    }
    objects[name] = object
    pos = next_pos
    while pos < #lines do
        local sub_name = lines[pos]:match("struct%s+([%w_]+)%s+{%s*") or lines[pos]:match("struct%s+([%w_]+)%s*$")
        if sub_name then
            lines[pos] = lines[pos]:gsub(sub_name, name .. "_" .. sub_name, 1)
            pos = read_struct(lines, objects, messages, pos)
        else
            local close_tag = read_field(objects, object.fields, lines[pos], pos, name)
            if close_tag then
                break
            else
                pos = pos + 1
            end
        end
    end
    pos = read_close_tag(lines, pos)
    return pos,name
end

local function read_message(lines, objects, messages, pos)
    local next_pos
    local content = lines[pos]
    local name,id,dest = content:match("message%s+([%w_]+)%s+(%d+)%s+{%s*")
    if not name then
        dest,name,id = content:match("message%s+([%w_]+.[%w_]+).([%w_]+)%s+(%d+)%s+{%s*")
    end
    if name then
        next_pos = pos + 1
    else
        name,id,dest = content:match("message%s+([%w_]+)%s+(%d+)%s*")
        if not name then
            dest,name,id = content:match("message%s+([%w_]+.[%w_]+).([%w_]+)%s+(%d+)%s*")
        end
        syntax_assert(name, pos)
        next_pos = read_begin_tag(lines, pos + 1)
    end
    syntax_assert(name, pos)
    id = syntax_assert(tonumber(id), pos)
    syntax_assert(id >= 0, pos)
    for _,message in pairs(messages) do
        if message.id == id then
            error(string.format("duplicate proto id '%d' at line:%d", id, pos))
        end
    end
    local message = {
        id = id,
        name = name,
        request = nil,
        response = nil,
        dest = dest, --forward to destination address(format node1.service1)
    }
    messages[name] = message

    --request
    pos = next_pos
    while pos < #lines do
        local content = lines[pos]
        if not is_empty(content) then
            if content:match("%s*request%s+{%s*") then
                content = content:gsub("request", "struct " .. name .. "_request", 1)
                lines[pos] = content
                pos,message.request = read_struct(lines, objects, messages, pos)
                break
            elseif content:match("%s*response%s+{%s*") then
                break
            else
                syntax_assert(false, pos)
            end
        else
            pos = pos + 1
        end
    end

    --response
    while pos < #lines do
        local content = lines[pos]
        if not is_empty(content) then
            if content:match("%s*response%s+{%s*") then
                content = content:gsub("response", "struct " .. name .. "_response", 1)
                lines[pos] = content
                pos,message.response = read_struct(lines, objects, messages, pos)
                break
            elseif is_close_tag(content) then
                break
            else
                syntax_assert(false, pos)
            end
        else
            pos = pos + 1
        end
    end

    pos = read_close_tag(lines, pos)

    return pos + 1
end

local function read_one_proto(lines, objects, messages, pos)
    while pos < #lines do
        local content = lines[pos]
        if content:find("struct ") then
            pos = read_struct(lines, objects, messages, pos)
        elseif content:find("message ") then
            pos = read_message(lines, objects, messages, pos)
        else
            syntax_assert(is_empty(content), pos)
            pos = pos + 1
        end
    end
    return pos
end

local function read_file(path)
    local f = io.open(path, "r")
    assert(f, "file open eror: " .. tostring(path))
    local text = f:read("*a")
    f:close()
    return text
end

local function line_compile(content)
    if content:find("//") then
        content = content:match("(.-)//")
    end
    return content
end

local function sproto_line_compile(content, pos)
    if content:find("#") then
        content = content:match("(.-)#")
    end
    local object_name = content:match("%s*%.([%w_]+.*)")
    if object_name then
        content = "struct " .. object_name
    else
        local name,id,array,type = content:match("%s*([%w_]+)%s+(%d+)%s*:%s*(%*-)([%w_]+)%s*")
        if name then
            content = "\t" .. type .. array .. " " .. name .. " = " .. id
        else
            if content:match("%s*([%w_]+)%s+(%d+)({*)%s*") then
               content = "message " .. content 
            end
        end
    end
    return content
end

local function compile_lines(text, compile)
    compile = compile or line_compile
    local c = string.byte("\n")
    local lines = {}
    local index = 0
    local pos = 1
    for i=1,#text do
        if string.byte(text, i) == c then
            index = index + 1
            local content = string.sub(text, pos, i - 1)
            lines[index] = compile(content, i)
            pos = i + 1
        end
    end
    lines[index+1] = string.sub(text, pos, #text)
    return lines
end

local function create_cobject(version, objects, object)
    if not object.cobject then
        local cobject = c.create_object(version, object.name)
        object.cobject = cobject
        for _,field in pairs(object.fields) do
            if field.object_names then
                assert(field.type == base_types.struct)
                local object
                for _,object_name in pairs(field.object_names) do
                    object = objects[object_name]
                    if object then
                        break
                    end
                end
                assert(object, string.format("type field '%s' undefined at line:%d", field.object_names[#field.object_names], field.pos))
                field.object = create_cobject(version, objects, object)
            end
            c.object_setfield(cobject, field.id, field.name, field.type, field.is_array, field.object, field.extra)
        end
    end
    return assert(object.cobject)
end

local function parse(text, compile)
    local lines = compile_lines(text, compile)
    local version = c.create_version()
    local objects = {}
    local messages = {}
    local pos = 1
    while pos < #lines do
        pos = read_one_proto(lines, objects, messages, pos)
    end
    local version = c.create_version()
    for name,object in pairs(objects) do
        create_cobject(version, objects, object)
    end
    for name,message in pairs(messages) do
        if message.request then
            local object = assert(objects[message.request])
            message.request = create_cobject(version, objects, object)
        end
        if message.response then
            local object = assert(objects[message.response])
            message.response = create_cobject(version, objects, object)
        end
        message.cobject = c.create_proto(version, name, message.id, message.request, message.response, message.dest)
    end
    return version
end

-------------------------------- interface --------------------------------

function qproto.parse(text)
    return parse(text)
end

--sproto message definition support
function qproto.parse_sproto(text)
    return parse(text, sproto_line_compile)
end

function qproto.save(version)
    c.save_version(version)
end

function qproto.reload()
    VERSION = assert(c.query_version())
end

function qproto.encode_request(cmd, args, session)
    return c.encode_request(VERSION, cmd, args, session or 0)
end

function qproto.decode_request(buffer)
    return c.decode_request(VERSION, buffer)
end

function qproto.encode_response(cmd, args, session)
    return c.encode_response(VERSION, cmd, args, session or 0)
end

function qproto.decode_response(buffer)
    return c.decode_response(VERSION, buffer)
end

function qproto.get_tag(cmd)
    return c.get_tag(VERSION, cmd)
end

return qproto