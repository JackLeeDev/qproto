#define LUA_LIB

#include <stdint.h>
#include <string.h>
#include <assert.h>
#include <lua.h>
#include <lauxlib.h>
#include "qdef.h"
#include "qbarray.h"
#include "qbuf.h"

#define MAX_DEPTH 24
#define MAX_PACKAGE_SIZE 60*1024
#define DOUBLE_FACTOR 100 // default 2 decimal places
#define QPROTO_TINTEGER 0 // extra: double(1) and boolean(2)
#define QPROTO_TSTRING 1 // extra: bytes(1)
#define QPROTO_TOBJECT 2

//***********************************************************
//  combine array-type type and small-value(size) in one bit
//  0-2 int string object
//  3-5 array: int string object
//  6-10 int value: 0-4
//  11-15 object array size: 0-4
//***********************************************************
#define is_small_value(value) (value)>=0&&(value)<=4

typedef struct qproto_field {
	const char* name;
	uint32_t id;
	uint8_t type;
	uint8_t is_array;
	uint8_t extra;
	struct qproto_object* object;
} qproto_field;

typedef struct qproto_object {
	const char* name;
	qbarray fields;
	qbarray id_fields;
} qproto_object;

typedef struct qproto {
	const char* name;
	int32_t id;
	struct qproto_object* request;
	struct qproto_object* response;
	const char* dest; // forward to destination address
} qproto;

typedef struct qproto_version {
	qbarray objects;
	qbarray protos;
	qbarray id_protos;
} qproto_version;

typedef struct qproto_encoder {
	char* buffer;
	int32_t cap;
	int32_t write_ptr;
	char err_msg[128];
} qproto_encoder;

typedef struct qproto_decoder {
	char* buffer;
	int32_t size;
	int32_t read_ptr;
	char err_msg[128];
} qproto_decoder;

static qproto_version* VERSION = NULL;

static int32_t object_compare(const void* a, const void* b) {
    return strcmp((*(const qproto_object**)a)->name, (*(const qproto_object**)b)->name);
}

static int32_t proto_compare(const void* a, const void* b) {
    return strcmp((*(const qproto**)a)->name, (*(const qproto**)b)->name);
}

static int32_t protoid_compare(const void* a, const void* b) {
    return (*(const qproto**)a)->id - (*(const qproto**)b)->id;
}

static int32_t field_compare(const void* a, const void* b) {
    return strcmp(((const qproto_field*)a)->name, ((const qproto_field*)b)->name);
}

static int32_t fieldid_compare(const void* a, const void* b) {
    return ((const qproto_field*)a)->id - ((const qproto_field*)b)->id;
}

static int32_t lcreate_version(lua_State *L) {
	qproto_version* v = (qproto_version*)malloc(sizeof(*v));
	memset(v, 0, sizeof(*v));
	qbarray_init(&v->objects, sizeof(qproto_object*), 4, object_compare);
	qbarray_init(&v->protos, sizeof(qproto*), 4, proto_compare);
	qbarray_init(&v->id_protos, sizeof(qproto*), 4, protoid_compare);
	lua_pushlightuserdata(L, v);
	return 1;
}

static int32_t lsave_version(lua_State *L) {
	qproto_version* v = lua_touserdata(L, 1);
	if (!v) {
		luaL_error(L, "Invalid version, is null");
	}
	VERSION = v;
	return 0;
}

static int32_t lquery_version(lua_State *L) {
	if (!VERSION) {
		luaL_error(L, "Invalid version, is null");
	}
	lua_pushlightuserdata(L, VERSION);
	return 1;
}

static int32_t lcreate_object(lua_State *L) {
	qproto_version* v = lua_touserdata(L, 1);
	if (!v) {
		luaL_error(L, "Invalid version, is null");
	}
	const char* name = luaL_checkstring(L, 2);
	qproto_object* o = (qproto_object*)malloc(sizeof(*o));
	memset(o, 0, sizeof(*o));
	o->name = name;
	if (qbarray_find(&v->objects, &o)) {
		free(o);
		luaL_error(L, "Duplicate object name '%s'", name);
	}
	o->name = qstrdup(name);
	qbarray_init(&o->fields, sizeof(qproto_field), 4, field_compare);
	qbarray_init(&o->id_fields, sizeof(qproto_field), 4, fieldid_compare);
	qbarray_insert(&v->objects, &o);
	lua_pushlightuserdata(L, o);
	return 1;
}

static int32_t lobject_setfield(lua_State *L) {
	qproto_object* o = (qproto_object*)lua_touserdata(L, 1);
	if (!o) {
		luaL_error(L, "Invalid object, is null");
	}
	qproto_field f;
	f.id = luaL_checkinteger(L, 2);
	f.name = luaL_checkstring(L, 3);
	f.type = luaL_checkinteger(L, 4);
	f.is_array = luaL_checkinteger(L, 5);
	f.object = (qproto_object*)lua_touserdata(L, 6);
	f.extra = luaL_checkinteger(L, 7);
	if (f.type == QPROTO_TOBJECT && !f.object) {
		luaL_error(L, "Field '%s' is object, but it's null", f.name);
	}
	if (qbarray_find(&o->fields, &f)) {
		luaL_error(L, "Duplicate field name '%s' in %s", f.name, o->name);
	}
	if (qbarray_find(&o->id_fields, &f)) {
		luaL_error(L, "Duplicate field id '%d' in %s", f.id, o->name);
	}
	f.name = qstrdup(f.name);
	qbarray_insert(&o->fields, &f);
	qbarray_insert(&o->id_fields, &f);
	return 0;
}

static int32_t lcreate_proto(lua_State *L) {
	qproto_version* v = lua_touserdata(L, 1);
	if (!v) {
		luaL_error(L, "Invalid version, is null");
	}
	const char* name = luaL_checkstring(L, 2);
	int32_t id = luaL_checkinteger(L, 3);
	if (id<0) {
		luaL_error(L, "Invalid proto id '%d'", id);
	}
	qproto_object* request = lua_touserdata(L, 4);
	qproto_object* response = lua_touserdata(L, 5);
	qproto* p = (qproto*)malloc(sizeof(*p));
	memset(p, 0, sizeof(*p));
	p->id = id;
	if (qbarray_find(&v->id_protos, &p)) {
		free(p);
		luaL_error(L, "Duplicate proto id '%d'", id);
	}
	p->name = name;
	if (qbarray_find(&v->protos, &p)) {
		free(p);
		luaL_error(L, "Duplicate proto name '%s'", name);
	}
	p->name = qstrdup(name);
	p->request = request;
	p->response = response;
	if (!lua_isnil(L, 6)) {
		const char* dest = luaL_checkstring(L, 6);
		p->dest = qstrdup(dest);
	}
	qbarray_insert(&v->protos, &p);
	qbarray_insert(&v->id_protos, &p);
	lua_pushlightuserdata(L, p);
	return 1;
}

static bool encode_object(lua_State *L, qproto_object* o, qproto_encoder* encoder, int32_t stack, int32_t depth);

static bool encode_field(lua_State *L, qproto_encoder* encoder, qproto_field* f, int32_t depth) {
	int32_t type = lua_type(L, -1);
	switch (f->type) {
		case QPROTO_TINTEGER: {
			int64_t value;
			if (f->extra != 2) {
				if (type == LUA_TNUMBER) {
					if (!f->extra) {
						value = lua_tointeger(L, -1);
					}
					else {
						value = (int64_t)(lua_tonumber(L, -1) * DOUBLE_FACTOR);
					}
				}
				else {
					snprintf(encoder->err_msg, sizeof(encoder->err_msg), "Type field '%s' number expected, got %s", 
						f->name, lua_typename(L, type));
					return false;
				}
			}
			else {
				if (type == LUA_TBOOLEAN) {
					value = lua_toboolean(L, -1);
				}
				else {
					snprintf(encoder->err_msg, sizeof(encoder->err_msg), "Type field '%s' boolean expected, got %s", 
						f->name, lua_typename(L, type));
					return false;
				}
			}
			if (!f->is_array && is_small_value(value)) {
				encoder->buffer[encoder->write_ptr-1] += (value+6)<<1; //skip end tag
			}
			else {
				write_integer(encoder, value);
			}
			break;
		}
		case QPROTO_TSTRING: {
			if (type == LUA_TSTRING) {
				size_t len = 0;
				const char* str = luaL_checklstring(L, -1, &len);
				write_uinteger(encoder, len);
				write_buf(encoder, str, len);
			}
			else {
				snprintf(encoder->err_msg, sizeof(encoder->err_msg), "Type field '%s' string expected, got %s", 
					f->name, lua_typename(L, type));
				return false;
			}
			break;
		}
		case QPROTO_TOBJECT: {
			if (type == LUA_TTABLE) {
				if (!encode_object(L, f->object, encoder, -1, depth)) {
					return false;
				}
			}
			else {
				snprintf(encoder->err_msg, sizeof(encoder->err_msg), "Type field '%s' table expected, got %s", 
					f->name, lua_typename(L, type));
				return false;
			}
			break;
		}
		default:
			assert(0);
			break;
	}
	return true;
}

static bool encode_array_field(lua_State *L, qproto_encoder* encoder, qproto_field* f, int32_t depth) {
	if (!lua_istable(L, -1)) {
		snprintf(encoder->err_msg, sizeof(encoder->err_msg), "Type field '%s' table expected, got %s", 
			f->name, luaL_typename(L, -1));
		return false;
	}
	int32_t size = (int32_t)lua_rawlen(L, -1);
	if (is_small_value(size)) {
		encoder->buffer[encoder->write_ptr-3] += (size+6)<<1; //skip end tag
		if (size == 0) {
			encoder->write_ptr -= 2;
		}
	}
	else {
		write_integer(encoder, size);
	}
	int32_t i;
	for (i=1; i<=size; ++i) {
		lua_geti(L, -1, i);
		if (encode_field(L, encoder, f, depth+1)) {
			lua_pop(L, 1);
		}
		else {
			lua_pop(L, 1);
			return false;
		}
	}
	return true;
}

static bool encode_object(lua_State *L, qproto_object* o, qproto_encoder* encoder, int32_t stack, int32_t depth) {
	if (depth > MAX_DEPTH) {
		snprintf(encoder->err_msg, sizeof(encoder->err_msg), "Attempt to encode an too depth table");
		return false;
	}
	int32_t size = 0;
	int32_t size_ptr = encoder->write_ptr;
	write_skip(encoder, 1);
	int32_t i;
	for (i=0; i<o->id_fields.size; ++i) {
		qproto_field* f = qbarray_get(&o->id_fields, i);
		lua_getfield(L, stack, f->name);
		if (!lua_isnil(L, -1)) {
			uint8_t type_value = f->type+(f->is_array?3:0);
			write_uinteger(encoder, (f->id<<4)|type_value);
			int32_t write_ptr = encoder->write_ptr;
			if (f->is_array || f->type == QPROTO_TOBJECT) {
				write_skip(encoder, 2);
			}
			if (f->is_array) {
				if (!encode_array_field(L, encoder, f, depth+1)) {
					lua_pop(L, 2);
					return false;
				}
			}
			else {
				if (!encode_field(L, encoder, f, depth+1)) {
					lua_pop(L, 2);
					return false;
				}
			}
			if (f->is_array || f->type == QPROTO_TOBJECT) {
				int32_t current_ptr = encoder->write_ptr;
				int32_t len = current_ptr - write_ptr - 2;
				encoder->write_ptr = write_ptr;
				write_byte(encoder, len>>8);
				write_byte(encoder, len&0xFF);
				encoder->write_ptr = current_ptr;
			}
			++size;
		}
		lua_pop(L, 1);
	}
	if (size <= 0x7f) {
		int32_t current_ptr = encoder->write_ptr;
		encoder->write_ptr = size_ptr;
		write_uinteger(encoder, size);
		encoder->write_ptr = current_ptr;
	}
	else {
		if (size <= 0x7fff) {
			buf_reserve(encoder, 1);
			memmove(encoder->buffer+size_ptr+2, encoder->buffer+size_ptr+1, (++encoder->write_ptr)-size_ptr-2);
			int32_t current_ptr = encoder->write_ptr;
			encoder->write_ptr = size_ptr;
			write_uinteger(encoder, size);
			encoder->write_ptr = current_ptr;
		}
		else {
			snprintf(encoder->err_msg, sizeof(encoder->err_msg), "Too large object field size:%d", size);
			return false;
		}
	}
	if (encoder->write_ptr > MAX_PACKAGE_SIZE) {
		snprintf(encoder->err_msg, sizeof(encoder->err_msg), "Attempt to encode an too large packet, size:%d max:%d", 
			encoder->write_ptr, MAX_PACKAGE_SIZE);
		return false;
	}
	return true;
}

static int32_t _encode(lua_State *L, bool is_request) {
	qproto_version* v = lua_touserdata(L, 1);
	if (!v) {
		luaL_error(L, "Invalid version, is null");
	}
	const char* name = luaL_checkstring(L, 2);
	luaL_checktype(L, 3, LUA_TTABLE);
	int64_t session = luaL_checkinteger(L, 4);
	lua_settop(L, 4);

	qproto tmp;
	tmp.name = name;
	qproto** pp = (qproto**)qbarray_find_value(&v->protos, &tmp);
	if (!pp) {
		luaL_error(L, "Proto name '%s' undefined", name);
	}
	qproto* p = *pp;
	qproto_object* o = is_request ? p->request : p->response;
	if (!o) {
		luaL_error(L, "Proto '%s.%s' undefined", name, is_request?"request":"response");
	}
	
	qproto_encoder encoder;
	memset(&encoder, 0, sizeof(encoder));

	//write id and session
	write_uinteger(&encoder, p->id);
	write_uinteger(&encoder, session);

	bool succ = encode_object(L, o, &encoder, 3, 1);
	if (succ) {
		assert(encoder.buffer);
		lua_pushlstring(L, encoder.buffer, encoder.write_ptr);
		free(encoder.buffer);
		return 1;
	}
	else {
		safe_free(encoder.buffer);
		lua_settop(L, 4);
		luaL_error(L, encoder.err_msg);
		return 0;
	}
}

static int32_t ldecode_header(lua_State *L) {
	qproto_version* v = lua_touserdata(L, 1);
	if (!v) {
		luaL_error(L, "Invalid version, is null");
	}
	size_t len = 0;
	const char* buffer = luaL_checklstring(L, 2, &len);
	if (len <= 2) {
		return luaL_error(L, "Invalid buffer, length = %d", len);
	}
	qproto_decoder decoder;
	decoder.buffer = (char*)buffer;
	decoder.size = len;
	decoder.read_ptr = 0;
	decoder.err_msg[0] = '\0';
	int64_t id = -1;
	if (!read_uinteger(&decoder, &id)) {
		luaL_error(L, "Decode error");
	}
	qproto tmp;
	tmp.id = id;
	qproto** pp = (qproto**)qbarray_find_value(&v->id_protos, &tmp);
	if (!pp) {
		luaL_error(L, "Proto id '%d' undefined", id);
	}
	qproto* p = *pp;
	lua_pushinteger(L, id);
	lua_pushstring(L, p->name);
	if (p->dest) {
		lua_pushstring(L, p->dest);
		return 3;
	}
	return 2;
}

static int32_t lencode_request(lua_State *L) {
	return _encode(L, true);
}

static int32_t lencode_response(lua_State *L) {
	return _encode(L, false);
}

static bool decode_object(lua_State *L, qproto_object* o, qproto_decoder* decoder);

static bool decode_field(lua_State *L, qproto_decoder* decoder, qproto_field* f) {
	switch (f->type) {
		case QPROTO_TINTEGER: {
			int64_t value;
			if (!read_integer(decoder, &value)) {
				goto fail;
			}
			if (f->extra) {
				lua_Number dvalue = value*1.0/DOUBLE_FACTOR;
				lua_pushnumber(L, dvalue);
			}
			else {
				lua_pushinteger(L, value);
			}
			break;
		}
		case QPROTO_TSTRING: {
			int64_t len;
			if (!read_uinteger(decoder, &len)) {
				goto fail;
			}
			const char* str = read_buf(decoder, len);
			if (!str) {
				goto fail;
			}
			lua_pushlstring(L, str, len);
			break;
		}
		case QPROTO_TOBJECT: {
			if (!decode_object(L, f->object, decoder)) {
				goto fail;
			}
			break;
		}
		default:
			goto fail;
			break;
	}
	return true;
fail:
	snprintf(decoder->err_msg, sizeof(decoder->err_msg), "Decode error");
	return false;
}

static bool decode_object(lua_State *L, qproto_object* o, qproto_decoder* decoder) {
	int64_t size = 0;
	if (!read_uinteger(decoder, &size)) {
		goto fail;
	}
	lua_createtable(L, 0, size);
	int32_t i;
	for (i=0; i<size; ++i) {
		int64_t id;
		if (!read_uinteger(decoder, &id)) {
			goto fail;
		}
		qproto_field tmp;
		tmp.id = id>>4;
		uint8_t type_value = id&0xf;
		uint8_t is_array = 0;
		uint8_t type = type_value;
		int32_t small_value = -1;
		
		qproto_field* f = (qproto_field*)qbarray_find(&o->id_fields, &tmp);
		if (type_value >= 3 && type_value <= 5) {
			is_array = 1;
			type = type_value - 3;
		}
		else if (type_value >= 6 && type_value <= 10) {
			if (f && f->is_array) {
				is_array = 1;
				small_value = type_value - (f->type + 3 + 6);
				type = f->type;
			} else {
				type = QPROTO_TINTEGER;
				small_value = type_value - 6;
			}
		}
		else if (type_value >= 11) {
			if (f && f->is_array) {
				is_array = 1;
				small_value = type_value - (f->type + 3 + 6);
				type = f->type;
			} else {
				is_array = 1;
				type = QPROTO_TOBJECT;
				small_value = type_value - 11;
			}
		}
		int32_t field_size = 0;
		if ((is_array && small_value!=0) || (!is_array && type==QPROTO_TOBJECT)) {
			uint8_t* buffer = (uint8_t*)read_buf(decoder, 2);
			if (!buffer) {
				goto fail;
			}
			field_size = ((int32_t)buffer[0]<<8)|(buffer[1]);
		}
		if (f) {
			if (f->type != type || f->is_array != is_array) {
				goto fail;
			}
		}
		else {
			if (is_array) {
				if (small_value != 0) {
					if (read_buf(decoder, field_size)) {
						continue;
					}
					else {
						goto fail;
					}
				}
				else {
					continue;
				}
			}
			else if (type == QPROTO_TOBJECT) {
				if (read_buf(decoder, field_size)) {
					continue;
				}
				else {
					goto fail;
				}
			}
			else if (type == QPROTO_TINTEGER) {
				if (small_value < 0) {
					int64_t value;
					read_integer(decoder, &value);
				}
				continue;
			}
			else if (type == QPROTO_TSTRING) {
				int64_t len;
				read_uinteger(decoder, &len);
				read_buf(decoder, len);
				continue;
			}
			else {
				goto fail;
			}
		}
		lua_pushstring(L, f->name);
		if (f->is_array) {
			int64_t arr_size = small_value;
			if (arr_size < 0) {
				if (!read_uinteger(decoder, &arr_size)) {
					goto fail;
				}
			}
			lua_createtable(L, arr_size, 0);
			int32_t j;
			for (j=1; j<=arr_size; ++j) {
				if (!decode_field(L, decoder, f)) {
					goto fail;
				}
				lua_rawseti(L, -2, j);
			}
		}
		else {
			if (small_value < 0) {
				if (!decode_field(L, decoder, f)) {
					goto fail;
				}
			}
			else {
				if (!f->extra) {
					lua_pushinteger(L, small_value);
				}
				else {
					if (f->extra == 1) {
						lua_pushnumber(L, small_value*1.0/DOUBLE_FACTOR);
					}
					else {
						lua_pushboolean(L, small_value?1:0);
					}
				}
			}
		}
		lua_rawset(L, -3);
	}
	return true;
fail:
	snprintf(decoder->err_msg, sizeof(decoder->err_msg), "Decode error");
	return false;
}

static int32_t _decode(lua_State *L, bool is_request) {
	qproto_version* v = lua_touserdata(L, 1);
	if (!v) {
		luaL_error(L, "Invalid version, is null");
	}
	size_t len = 0;
	const char* buffer = luaL_checklstring(L, 2, &len);
	if (len <= 2) {
		return luaL_error(L, "Invalid buffer, length = %d", len);
	}
	lua_settop(L, 2);

	qproto_decoder decoder;
	decoder.buffer = (char*)buffer;
	decoder.size = len;
	decoder.read_ptr = 0;
	decoder.err_msg[0] = '\0';

	int64_t id = -1;
	if (!read_uinteger(&decoder, &id)) {
		luaL_error(L, "Decode error");
	}
	int64_t session = 0;
	if (!read_uinteger(&decoder, &session)) {
		luaL_error(L, "Decode error");
	}

	qproto tmp;
	tmp.id = id;
	qproto** pp = (qproto**)qbarray_find_value(&v->id_protos, &tmp);
	if (!pp) {
		luaL_error(L, "Proto id '%d' undefined", id);
	}
	qproto* p = *pp;
	qproto_object* o = is_request ? p->request : p->response;
	if (!o) {
		luaL_error(L, "Proto '%s.%s' undefined", p->name, is_request?"request":"response");
	}

	lua_pushstring(L, p->name);
	bool succ = decode_object(L, o, &decoder);
	if (succ) {
		lua_pushinteger(L, session);
		if (is_request && p->dest) {
			lua_pushstring(L, p->dest);
			return 4;
		}
		return 3;
	}
	else {
		lua_settop(L, 2);
		luaL_error(L, decoder.err_msg);
		return 0;
	}
}

static int32_t ldecode_request(lua_State *L) {
	return _decode(L, true);
}

static int32_t ldecode_response(lua_State *L) {
	return _decode(L, false);
}

static int32_t lget_tag(lua_State *L) {
	qproto_version* v = lua_touserdata(L, 1);
	if (!v) {
		luaL_error(L, "Invalid version, is null");
	}
	const char* name = luaL_checkstring(L, 2);
	qproto tmp;
	tmp.name = name;
	qproto** pp = (qproto**)qbarray_find_value(&v->protos, &tmp);
	if (!pp) {
		luaL_error(L, "Proto name '%s' undefined", name);
	}
	qproto* p = *pp;
	lua_pushinteger(L, p->id);
	return 1;
}

LUAMOD_API int32_t luaopen_qproto_core(lua_State* L) {
	luaL_Reg l[] = {
		{ "create_version", lcreate_version },
		{ "create_object", lcreate_object },
		{ "object_setfield", lobject_setfield },
		{ "create_proto", lcreate_proto },
		{ "save_version", lsave_version },
		{ "query_version", lquery_version },
		{ "decode_header", ldecode_header },
		{ "encode_request", lencode_request },
		{ "encode_response", lencode_response },
		{ "decode_request", ldecode_request },
		{ "decode_response", ldecode_response },
		{ "get_tag", lget_tag },
		{ NULL, NULL },
	};
	luaL_newlib(L, l);
	return 1;
}
