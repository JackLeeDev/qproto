const qproto = (function() {
    const MAX_DEPTH = 24;
    const MAX_PACKAGE_SIZE = 60 * 1024;
    const DOUBLE_FACTOR = 100;

    // type constants
    const QPROTO_TINTEGER = 0;
    const QPROTO_TSTRING = 1;
    const QPROTO_TOBJECT = 2;

    // base type mapping
    const base_types = {
        integer: 0,
        double: 0, //integer extra
        boolean: 0, //integer extra2
        string: 1,
        bytes: 1, //string extra
        struct: 2
    };

    // helper functions
    function is_small_value(value) {
        return value >= 0 && value <= 4;
    }

    function is_empty(str) {
        return !/\S/.test(str);
    }

    function is_begin_tag(str) {
        return /\s*\{\s*/.test(str);
    }

    function is_close_tag(str) {
        return /\s*\}\s*/.test(str);
    }

    function syntax_assert(condition, pos) {
        if (!condition) {
            throw new Error(`syntax error at line:${pos}`);
        }
        return condition;
    }

    const encode_buffer = new Array(10);
    const decode_buffer = new Array(10);
    const encoder_pool = [];
    const decoder_pool = [];
    var VERSION = null;

    function acquire_encoder() {
        return encoder_pool.pop() || new Encoder();
    }

    function release_encoder(encoder) {
        encoder.write_ptr = 0;
        if (encoder_pool.length < 100) {
            encoder_pool.push(encoder);
        }
    }

    function acquire_decoder(buffer) {
        if (buffer === undefined) {
            return new Decoder();
        }
        const decoder = decoder_pool.pop() || new Decoder();
        decoder.buffer = buffer;
        decoder.size = buffer.length;
        decoder.read_ptr = 0;
        return decoder;
    }

    function release_decoder(decoder) {
        if (decoder_pool.length < 100) {
            decoder_pool.push(decoder);
        }
    }

    class Encoder {
        constructor() {
            this.buffer = [];
            this.write_ptr = 0;
        }

        buf_reserve(add_size) {
            if (this.write_ptr + add_size > this.buffer.length) {
                while (this.write_ptr + add_size > this.buffer.length) {
                    this.buffer.length = this.buffer.length > 0 ? this.buffer.length * 2 : 64;
                }
            }
        }

        write_byte(b) {
            this.buf_reserve(1);
            this.buffer[this.write_ptr++] = b;
        }

        write_integer(value) {
            const negative = value < 0;
            if (negative) {
                value = -value;
            }

            // 使用 BigInt 避免 32 位位运算溢出
            const big_value = typeof value === 'bigint' ? value : BigInt(value);
            let nbyte = 0;
            for (let i = 0; i < 10; i++) {
                nbyte++;
                const write_idx = 9 - i;
                let b;
                if (i !== 0) {
                    const shift = BigInt(7 * i - 1);
                    b = Number((big_value >> shift) & 0xFEn);
                } else {
                    if (big_value <= 0x3Fn) {
                        b = (Number(big_value << 1n) & 0x7E) | 1;
                    } else {
                        b = (Number(big_value << 1n) & 0xFE) | 1;
                    }
                }
                encode_buffer[write_idx] = b & 0xFF;
                if (big_value < (1n << BigInt(i * 7 + 6)) || i >= 9) {
                    if (negative) {
                        encode_buffer[write_idx] |= 0x80;
                    }
                    this.buf_reserve(nbyte);
                    const start_idx = 10 - nbyte;
                    for (let j = 0; j < nbyte; j++) {
                        this.buffer[this.write_ptr++] = encode_buffer[start_idx + j];
                    }
                    break;
                }
            }
            return nbyte;
        }

        write_uinteger(value) {
            const big_value = typeof value === 'bigint' ? value : BigInt(value);
            let nbyte = 0;
            for (let i = 0; i < 9; i++) {
                nbyte++;
                const write_idx = 8 - i;
                if (i !== 0) {
                    const shift = BigInt(7 * i - 1);
                    encode_buffer[write_idx] = Number((big_value >> shift) & 0xFEn);
                } else {
                    encode_buffer[write_idx] = (Number(big_value << 1n) & 0xFE) | 1;
                }
                if (big_value < (1n << BigInt((i + 1) * 7)) || i >= 8) {
                    this.buf_reserve(nbyte);
                    const start_idx = 9 - nbyte;
                    for (let j = 0; j < nbyte; j++) {
                        const byte = encode_buffer[start_idx + j];
                        this.buffer[this.write_ptr++] = byte;
                    }
                    return nbyte;
                }
            }
            return nbyte;
        }

        write_buf(buf) {
            const len = buf.length;
            this.buf_reserve(len);
            let i = 0;
            while (i < len) {
                this.buffer[this.write_ptr++] = buf[i++];
            }
        }

        write_string(str) {
            let len = 0;
            for (let i = 0; i < str.length; i++) {
                const code = str.charCodeAt(i);
                if (code < 0x80) {
                    len += 1;
                } else if (code < 0x800) {
                    len += 2;
                } else if (code >= 0xD800 && code <= 0xDBFF) {
                    len += 4;
                    i++;
                } else {
                    len += 3;
                }
            }
            this.write_uinteger(len);
            this.buf_reserve(len);
            // utf8
            for (let i = 0; i < str.length; i++) {
                const code = str.charCodeAt(i);
                if (code < 0x80) {
                    this.buffer[this.write_ptr++] = code;
                } else if (code < 0x800) {
                    this.buffer[this.write_ptr++] = 0xC0 | (code >> 6);
                    this.buffer[this.write_ptr++] = 0x80 | (code & 0x3F);
                } else if (code >= 0xD800 && code <= 0xDBFF) {
                    const low = str.charCodeAt(i + 1);
                    if (low >= 0xDC00 && low <= 0xDFFF) {
                        i++;
                        const codePoint = ((code - 0xD800) << 10) + (low - 0xDC00) + 0x10000;
                        this.buffer[this.write_ptr++] = 0xF0 | (codePoint >> 18);
                        this.buffer[this.write_ptr++] = 0x80 | ((codePoint >> 12) & 0x3F);
                        this.buffer[this.write_ptr++] = 0x80 | ((codePoint >> 6) & 0x3F);
                        this.buffer[this.write_ptr++] = 0x80 | (codePoint & 0x3F);
                    }
                } else {
                    this.buffer[this.write_ptr++] = 0xE0 | (code >> 12);
                    this.buffer[this.write_ptr++] = 0x80 | ((code >> 6) & 0x3F);
                    this.buffer[this.write_ptr++] = 0x80 | (code & 0x3F);
                }
            }
        }

        write_bytes(data) {
            // Support Buffer, Uint8Array, or Array-like objects
            const len = data.length;
            this.write_uinteger(len);
            this.buf_reserve(len);
            for (let i = 0; i < len; i++) {
                this.buffer[this.write_ptr++] = data[i];
            }
        }

        write_skip(skip_size) {
            this.buf_reserve(skip_size);
            this.write_ptr += skip_size;
        }

        get_data() {
            return Buffer.from(this.buffer.slice(0, this.write_ptr));
        }
    }

    class Decoder {
        constructor(buffer) {
            if (buffer !== undefined) {
                this.buffer = buffer;
                this.size = buffer.length;
                this.read_ptr = 0;
            }
        }

        read_byte() {
            if (this.read_ptr >= this.size) {
                return null;
            }
            return this.buffer[this.read_ptr++];
        }

        read_integer() {
            let b0 = this.read_byte();
            if (b0 === null) return null;

            const negative = (b0 & 0x80) !== 0;
            const v0 = (b0 & 0x7F) >> 1;

            // 1 byte
            if ((b0 & 0x01) !== 0) {
                return negative ? -v0 : v0;
            }

            // 2 byte
            let b1 = this.read_byte();
            if (b1 === null) return null;
            decode_buffer[0] = b0;
            decode_buffer[1] = b1;

            let value = (v0 << 7) + (b1 >> 1);
            if ((b1 & 0x01) !== 0) {
                return negative ? -value : value;
            }

            // 3 byte
            let b2 = this.read_byte();
            if (b2 === null) return null;
            decode_buffer[2] = b2;

            value = (value << 7) + (b2 >> 1);
            if ((b2 & 0x01) !== 0) {
                return negative ? -value : value;
            }

            // 4 byte
            let b3 = this.read_byte();
            if (b3 === null) return null;
            decode_buffer[3] = b3;

            value = (value << 7) + (b3 >> 1);
            if ((b3 & 0x01) !== 0) {
                return negative ? -value : value;
            }

            // more
            let nbyte = 4;
            let bigValue = BigInt(v0) << 21n | BigInt(b1 >> 1) << 14n | BigInt(b2 >> 1) << 7n | BigInt(b3 >> 1);

            for (let i = 4; i < 10; i++) {
                const b = this.read_byte();
                if (b === null) return null;
                decode_buffer[nbyte++] = b;
                bigValue = (bigValue << 7n) + BigInt(b >> 1);
                if ((b & 0x01) !== 0) break;
            }

            return Number(negative ? -bigValue : bigValue);
        }

        read_uinteger() {
            let b0 = this.read_byte();
            if (b0 === null) return null;

            const v0 = b0 >> 1;

            // 1 byte
            if ((b0 & 0x01) !== 0) {
                return v0;
            }

            // 2 byte
            let b1 = this.read_byte();
            if (b1 === null) return null;
            decode_buffer[0] = b0;
            decode_buffer[1] = b1;

            let value = (v0 << 7) + (b1 >> 1);
            if ((b1 & 0x01) !== 0) {
                return value;
            }

            // 3 byte
            let b2 = this.read_byte();
            if (b2 === null) return null;
            decode_buffer[2] = b2;

            value = (value << 7) + (b2 >> 1);
            if ((b2 & 0x01) !== 0) {
                return value;
            }

            // 4 byte
            let b3 = this.read_byte();
            if (b3 === null) return null;
            decode_buffer[3] = b3;

            value = (value << 7) + (b3 >> 1);
            if ((b3 & 0x01) !== 0) {
                return value;
            }

            // more
            let nbyte = 4;
            let bigValue = BigInt(v0) << 21n | BigInt(b1 >> 1) << 14n | BigInt(b2 >> 1) << 7n | BigInt(b3 >> 1);

            for (let i = 4; i < 9; i++) {
                const b = this.read_byte();
                if (b === null) return null;
                decode_buffer[nbyte++] = b;
                bigValue = (bigValue << 7n) + BigInt(b >> 1);
                if ((b & 0x01) !== 0) break;
            }

            return Number(bigValue);
        }

        read_buf(buf_size) {
            if (this.read_ptr + buf_size > this.size) {
                return null;
            }
            const buf = this.buffer.slice(this.read_ptr, this.read_ptr + buf_size);
            this.read_ptr += buf_size;
            return buf;
        }

        read_string() {
            const len = this.read_uinteger();
            if (len === null) {
                return null;
            }
            const buf = this.read_buf(len);
            if (!buf) {
                return null;
            }
            // utf8 decode
            let str = '';
            let i = 0;
            while (i < len) {
                const b1 = buf[i++];
                if (b1 < 0x80) {
                    str += String.fromCharCode(b1);
                } else if ((b1 & 0xE0) === 0xC0) {
                    const b2 = buf[i++];
                    str += String.fromCharCode(((b1 & 0x1F) << 6) | (b2 & 0x3F));
                } else if ((b1 & 0xF0) === 0xE0) {
                    const b2 = buf[i++];
                    const b3 = buf[i++];
                    str += String.fromCharCode(((b1 & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F));
                } else if ((b1 & 0xF8) === 0xF0) {
                    // 4 byte utf8 (emoji)
                    const b2 = buf[i++];
                    const b3 = buf[i++];
                    const b4 = buf[i++];
                    const codePoint = ((b1 & 0x07) << 18) | ((b2 & 0x3F) << 12) | ((b3 & 0x3F) << 6) | (b4 & 0x3F);
                    // utf16
                    const code = codePoint - 0x10000;
                    const high = 0xD800 + (code >> 10);
                    const low = 0xDC00 + (code & 0x3FF);
                    str += String.fromCharCode(high, low);
                }
            }
            return str;
        }

        read_bytes() {
            const len = this.read_uinteger();
            if (len === null) {
                return null;
            }
            const buf = this.read_buf(len);
            if (!buf) {
                return null;
            }
            // Return as Buffer for raw bytes
            return Buffer.from(buf);
        }
    }

    // protocol structures
    class Field {
        constructor(id, name, type, is_array, object, extra) {
            this.id = id;
            this.name = name;
            this.type = type;
            this.is_array = is_array;
            this.object = object;
            this.extra = extra;
            this.object_names = null;
        }
    }

    class ObjectDef {
        constructor(name) {
            this.name = name;
            this.fields = {};
            this.field_list = [];
            this.id_fields = [];
        }

        add_field(field) {
            if (this.fields[field.name]) {
                throw new Error(`Duplicate field name '${field.name}' in ${this.name}`);
            }
            const existing = this.id_fields.find(f => f.id === field.id);
            if (existing) {
                throw new Error(`Duplicate field id '${field.id}' in ${this.name}`);
            }
            this.fields[field.name] = field;
            this.field_list.push(field);
            this.field_list.sort((a, b) => a.name.localeCompare(b.name));
            this.id_fields.push(field);
            this.id_fields.sort((a, b) => a.id - b.id);
        }

        get_field(id) {
            return this.id_fields.find(f => f.id === id);
        }
    }

    class ProtoDef {
        constructor(name, id, request, response, dest) {
            this.name = name;
            this.id = id;
            this.request = request;
            this.response = response;
            this.dest = dest;
        }
    }

    class Version {
        constructor() {
            this.objects = {};
            this.protos = {};
            this.id_protos = [];
        }

        add_object(obj) {
            if (this.objects[obj.name]) {
                throw new Error(`Duplicate object name '${obj.name}'`);
            }
            this.objects[obj.name] = obj;
        }

        add_proto(proto) {
            if (this.protos[proto.name]) {
                throw new Error(`Duplicate proto name '${proto.name}'`);
            }
            const existing = this.id_protos.find(p => p.id === proto.id);
            if (existing) {
                throw new Error(`Duplicate proto id '${proto.id}'`);
            }
            this.protos[proto.name] = proto;
            this.id_protos.push(proto);
            this.id_protos.sort((a, b) => a.id - b.id);
        }

        get_proto_by_id(id) {
            return this.id_protos.find(p => p.id === id);
        }

        get_proto_by_name(name) {
            return this.protos[name];
        }

        get_object(name) {
            return this.objects[name];
        }
    }

    // encoding functions
    function encode_field(encoder, field, value, depth) {
        switch (field.type) {
            case QPROTO_TINTEGER: {
                let num_value;
                if (field.extra === 2) {
                    if (value !== true && value !== false) {
                        throw new Error(`Field '${field.name}' boolean expected`);
                    }
                    num_value = value ? 1 : 0;
                } else {
                    const valueType = typeof value;
                    if (valueType !== 'number' && valueType !== 'bigint') {
                        throw new Error(`Field '${field.name}' number expected`);
                    }
                    if (field.extra === 1) {
                        // double
                        num_value = Math.round(Number(value) * DOUBLE_FACTOR);
                    } else {
                        num_value = valueType === 'bigint' ? value : Math.trunc(value);
                    }
                }

                if (!field.is_array && is_small_value(Number(num_value))) {
                    encoder.buffer[encoder.write_ptr - 1] += ((Number(num_value) + 6) << 1);
                } else {
                    encoder.write_integer(num_value);
                }
                break;
            }
            case QPROTO_TSTRING: {
                if (field.extra === 1) {
                    // bytes type: accept Buffer, Uint8Array, or Array-like
                    if (typeof value === 'string') {
                        // Allow string as well, treat as raw bytes
                        encoder.write_bytes(Buffer.from(value, 'binary'));
                    } else if (value && typeof value.length === 'number') {
                        // Buffer, Uint8Array, or Array-like
                        encoder.write_bytes(value);
                    } else {
                        throw new Error(`Field '${field.name}' bytes expected`);
                    }
                } else {
                    // string type
                    if (typeof value !== 'string') {
                        throw new Error(`Field '${field.name}' string expected`);
                    }
                    encoder.write_string(value);
                }
                break;
            }
            case QPROTO_TOBJECT: {
                if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                    throw new Error(`Field '${field.name}' object expected`);
                }
                encode_object(encoder, field.object, value, depth + 1);
                break;
            }
        }
    }

    function encode_array_field(encoder, field, arr, type_ptr, depth) {
        if (!Array.isArray(arr)) {
            throw new Error(`Field '${field.name}' array expected`);
        }
        const size = arr.length;
        if (is_small_value(size)) {
            encoder.buffer[type_ptr] += ((size + 6) << 1);
            if (size === 0) {
                encoder.write_ptr -= 2;
            }
        } else {
            encoder.write_uinteger(size);
        }
        for (let i = 0; i < size; i++) {
            encode_field(encoder, field, arr[i], depth + 1);
        }
    }

    function encode_object(encoder, obj, data, depth) {
        if (depth > MAX_DEPTH) {
            throw new Error('Attempt to encode an too depth table');
        }

        const size_ptr = encoder.write_ptr;
        encoder.write_skip(1);

        let size = 0;
        const fields = obj.id_fields;
        const fieldCount = fields.length;
        for (let i = 0; i < fieldCount; i++) {
            const field = fields[i];
            const value = data[field.name];
            if (value !== undefined && value !== null) {
                const type_value = field.type + (field.is_array ? 3 : 0);
                const encoded = (field.id << 4) | type_value;
                encoder.write_uinteger(encoded);

                const write_ptr = encoder.write_ptr;
                if (field.is_array || field.type === QPROTO_TOBJECT) {
                    encoder.write_skip(2);
                }
                
                const type_ptr = encoder.write_ptr - 3;

                if (field.is_array) {
                    encode_array_field(encoder, field, value, type_ptr, depth + 1);
                } else {
                    encode_field(encoder, field, value, depth + 1);
                }

                if (field.is_array || field.type === QPROTO_TOBJECT) {
                    const current_ptr = encoder.write_ptr;
                    const len = current_ptr - write_ptr - 2;
                    encoder.buffer[write_ptr] = (len >> 8) & 0xFF;
                    encoder.buffer[write_ptr + 1] = len & 0xFF;
                }

                size++;
            }
        }

        // write object size at the beginning
        if (size <= 0x7f) {
            const current_ptr = encoder.write_ptr;
            encoder.write_ptr = size_ptr;
            encoder.write_uinteger(size);
            encoder.write_ptr = current_ptr;
        } else if (size <= 0x7fff) {
            encoder.buf_reserve(1);
            encoder.buffer.splice(size_ptr + 2, 0, encoder.buffer[size_ptr + 1]);
            encoder.write_ptr++;
            const current_ptr = encoder.write_ptr;
            encoder.write_ptr = size_ptr;
            encoder.write_uinteger(size);
            encoder.write_ptr = current_ptr;
        } else {
            throw new Error(`Too large object field size:${size}`);
        }

        if (encoder.write_ptr > MAX_PACKAGE_SIZE) {
            throw new Error(`Attempt to encode an too large packet, size:${encoder.write_ptr} max:${MAX_PACKAGE_SIZE}`);
        }
    }

    // decoding functions
    function decode_field(decoder, field) {
        switch (field.type) {
            case QPROTO_TINTEGER: {
                const value = decoder.read_integer();
                if (value === null) {
                    return null;
                }
                if (field.extra === 1) {
                    return value / DOUBLE_FACTOR;
                } else if (field.extra === 2) {
                    return value !== 0;
                }
                return value;
            }
            case QPROTO_TSTRING: {
                if (field.extra === 1) {
                    // bytes type: return Buffer
                    return decoder.read_bytes();
                }
                return decoder.read_string();
            }
            case QPROTO_TOBJECT: {
                return decode_object(decoder, field.object);
            }
        }
        return null;
    }

    function decode_object(decoder, obj) {
        const size = decoder.read_uinteger();
        if (size === null) {
            return null;
        }

        const result = {};
        for (let i = 0; i < size; i++) {
            const id = decoder.read_uinteger();
            if (id === null) {
                return null;
            }

            const field_id = id >> 4;
            const field = obj.get_field(field_id);

            let type_value = id & 0xf;
            let is_array = 0;
            let type = type_value;
            let small_value = -1;

            if (field) {
                if (field.is_array) {
                    is_array = 1;
                    if (type_value >= 3 && type_value <= 5) {
                        type = type_value - 3;
                    } else if (type_value >= 6 && type_value <= 10) {
                        small_value = type_value - (field.type + 3 + 6);
                        type = field.type;
                    } else if (type_value >= 11) {
                        small_value = type_value - (field.type + 3 + 6);
                        type = field.type;
                    }
                }
            }

            // fallback for unknown fields
            if (!field) {
                if (type_value >= 3 && type_value <= 5) {
                    is_array = 1;
                    type = type_value - 3;
                } else if (type_value >= 6 && type_value <= 10) {
                    type = QPROTO_TINTEGER;
                    small_value = type_value - 6;
                } else if (type_value >= 11) {
                    is_array = 1;
                    type = QPROTO_TOBJECT;
                    small_value = type_value - 11;
                }
            } else if (!field.is_array) {
                // non-array field
                if (type_value >= 6 && type_value <= 10) {
                    type = QPROTO_TINTEGER;
                    small_value = type_value - 6;
                }
            }

            let field_size = 0;
            if ((is_array && small_value !== 0) || (!is_array && type === QPROTO_TOBJECT)) {
                const b1 = decoder.read_byte();
                const b2 = decoder.read_byte();
                if (b1 === null || b2 === null) {
                    return null;
                }
                field_size = (b1 << 8) | b2;
            }

            if (!field) {
                // skip unknown field
                if (is_array) {
                    if (small_value < 0) {
                        const arr_size = decoder.read_uinteger();
                        if (arr_size === null) {
                            return null;
                        }
                        for (let j = 0; j < arr_size; j++) {
                            if (type === QPROTO_TINTEGER) {
                                decoder.read_integer();
                            } else if (type === QPROTO_TSTRING) {
                                const len = decoder.read_uinteger();
                                decoder.read_buf(len);
                            } else if (type === QPROTO_TOBJECT) {
                                const obj_size = decoder.read_uinteger();
                                for (let k = 0; k < obj_size; k++) {
                                    const fid = decoder.read_uinteger();
                                    const tid = fid & 0xf;
                                    const t_is_array = tid >= 3 && tid <= 5;
                                    const t_type = t_is_array ? tid - 3 : tid;
                                    let t_field_size = 0;
                                    if ((t_is_array && (tid - 11) !== 0) || (!t_is_array && t_type === QPROTO_TOBJECT)) {
                                        decoder.read_buf(2);
                                    }
                                    if (t_type === QPROTO_TINTEGER && tid < 6) {
                                        decoder.read_integer();
                                    } else if (t_type === QPROTO_TSTRING) {
                                        const len = decoder.read_uinteger();
                                        decoder.read_buf(len);
                                    } else {
                                        const len = decoder.read_uinteger();
                                        decoder.read_buf(len);
                                    }
                                }
                            }
                        }
                    }
                } else if (type === QPROTO_TOBJECT) {
                    decoder.read_buf(field_size);
                } else if (type === QPROTO_TINTEGER) {
                    if (small_value < 0) {
                        decoder.read_integer();
                    }
                } else if (type === QPROTO_TSTRING) {
                    const len = decoder.read_uinteger();
                    decoder.read_buf(len);
                }
                continue;
            }

            if (field.type !== type || (field.is_array ? 1 : 0) !== is_array) {
                return null;
            }

            if (is_array) {
                let arr_size = small_value;
                if (arr_size < 0) {
                    arr_size = decoder.read_uinteger();
                    if (arr_size === null) {
                        return null;
                    }
                }

                const arr_result = new Array(arr_size);
                for (let j = 0; j < arr_size; j++) {
                    const value = decode_field(decoder, field);
                    if (value === null) {
                        return null;
                    }
                    arr_result[j] = value;
                }
                result[field.name] = arr_result;
            } else {
                let value;
                if (small_value < 0) {
                    value = decode_field(decoder, field);
                    if (value === null) {
                        return null;
                    }
                } else {
                    if (!field.extra) {
                        value = small_value;
                    } else {
                        if (field.extra === 1) {
                            value = small_value / DOUBLE_FACTOR;
                        } else {
                            value = small_value !== 0;
                        }
                    }
                }
                result[field.name] = value;
            }
        }

        return result;
    }

    // public api
    const interface_obj = {
        parse(text) {
            return parse(text, line_compile);
        },

        parse_sproto(text) {
            return parse(text, sproto_line_compile);
        },

        save(version) {
            VERSION = version;
        },

        encode(version, name, msg, session, is_request) {
            const proto = version.get_proto_by_name(name);
            if (!proto) {
                throw new Error(`Proto name '${name}' undefined`);
            }

            const obj = is_request ? proto.request : proto.response;
            if (!obj) {
                throw new Error(`Proto '${name}.${is_request ? 'request' : 'response'}' undefined`);
            }

            const encoder = acquire_encoder();
            encoder.write_uinteger(proto.id);
            encoder.write_uinteger(session);
            encode_object(encoder, obj, msg, 1);

            const result = encoder.get_data();
            release_encoder(encoder);
            return result;
        },

        decode(version, buffer, is_request) {
            const decoder = acquire_decoder(buffer);

            const id = decoder.read_uinteger();
            if (id === null) {
                throw new Error('Decode error: invalid id');
            }

            const session = decoder.read_uinteger();
            if (session === null) {
                throw new Error('Decode error: invalid session');
            }

            const proto = version.get_proto_by_id(id);
            if (!proto) {
                throw new Error(`Proto id '${id}' undefined`);
            }

            const obj = is_request ? proto.request : proto.response;
            if (!obj) {
                throw new Error(`Proto '${proto.name}.${is_request ? 'request' : 'response'}' undefined`);
            }

            const msg = decode_object(decoder, obj);
            if (!msg) {
                throw new Error('Decode error');
            }

            const ret = {
                pname: proto.name,
                result: msg,
                session: session
            };

            if (is_request && proto.dest) {
                ret.dest = proto.dest;
            }

            release_decoder(decoder);
            return ret;
        },

        decode_header(buffer) {
            const decoder = acquire_decoder(buffer);

            const id = decoder.read_uinteger();
            if (id === null) {
                throw new Error('Decode error: invalid id');
            }

            const proto = VERSION.get_proto_by_id(id);
            if (!proto) {
                throw new Error(`Proto id '${id}' undefined`);
            }

            const result = {
                id: id,
                name: proto.name
            };

            if (proto.dest) {
                result.dest = proto.dest;
            }

            release_decoder(decoder);
            return result;
        },

        encode_request(name, msg, session) {
            return this.encode(VERSION, name, msg, session?session:0, true);
        },

        encode_response(name, msg, session) {
            return this.encode(VERSION, name, msg, session?session:0, false);
        },

        decode_request(buffer) {
            return this.decode(VERSION, buffer, true);
        },

        decode_response(buffer) {
            return this.decode(VERSION, buffer, false);
        },

        create_version() {
            return new Version();
        }
    };

    // parsing helpers
    function line_compile(content) {
        const idx = content.indexOf('//');
        if (idx !== -1) {
            content = content.substring(0, idx);
        }
        return content;
    }

    function sproto_line_compile(content, pos) {
        const idx = content.indexOf('#');
        if (idx !== -1) {
            content = content.substring(0, idx);
        }

        const match = content.match(/\s*\.([\w_\.]+)\s*(\{*)/);
        if (match) {
            return `struct ${match[1]}${match[2]}`;
        }

        const field_match = content.match(/\s*(\w+)\s+(\d+)\s*:\s*(\*?)([\w\(\)]+)\s*/);
        if (field_match) {
            const [, name, id, array, type] = field_match;
            const cleanType = type.replace(/\([^)]*\)/g, '');
            return `\t${cleanType}${array} ${name} = ${id}`;
        }

        const msg_match = content.match(/\s*(\w+)\s+(\d+)\s*(\{*)\s*/);
        if (msg_match) {
            return `message ${content}`;
        }

        return content;
    }

    function compile_lines(text, compile) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            lines[i] = compile(lines[i], i + 1);
        }
        return lines;
    }

    function read_normal_field(objects, fields, content, pos, is_array, namespace) {
        const match = content.match(/\s*([\w_]+)\s+([\w_]+)\s*=\s*(\d+)\s*/);
        if (!match) {
            console.error(`read_normal_field failed at line ${pos}: [${content}]`);
        }
        syntax_assert(match, pos);
        const [, field_type, name, field_id] = match;

        syntax_assert(name, pos);
        syntax_assert(field_id !== undefined && field_id !== null, pos);
        const parsed = parseInt(field_id, 10);
        syntax_assert(!isNaN(parsed), pos);
        const id_num = parsed;
        syntax_assert(id_num >= 0, pos);

        let extra = 0;
        if (field_type === 'double' || field_type === 'bytes') {
            extra = 1;
        } else if (field_type === 'boolean') {
            extra = 2;
        }

        const field = {
            id: id_num,
            name: name,
            is_array: is_array,
            type: null,
            object: null,
            object_names: null,
            extra: extra,
            pos: pos
        };

        if (base_types.hasOwnProperty(field_type)) {
            field.type = base_types[field_type];
        } else {
            field.type = base_types.struct;
            field.object_names = [];
            const parts = namespace.split('_');
            let prefix = '';
            for (let i = 0; i < parts.length; i++) {
                prefix = prefix === '' ? parts[i] : prefix + '_' + parts[i];
                field.object_names.unshift(prefix + '_' + field_type);
            }
            field.object_names.push(field_type);
            field.pos = pos;
        }


        if (fields[name]) {
            throw new Error(`Duplicate field name '${name}' at line:${pos}`);
        }
        for (const key in fields) {
            if (fields[key].id === id_num) {
                throw new Error(`Duplicate field id '${id_num}' at line:${pos}`);
            }
        }

        fields[name] = field;
    }

    function read_array_field(objects, fields, content, pos, namespace) {
        content = content.replace('*', '');
        read_normal_field(objects, fields, content, pos, true, namespace);
    }

    function is_tag(lines, pos, func) {
        while (pos < lines.length) {
            const content = lines[pos];
            if (!is_empty(content)) {
                syntax_assert(func(content), pos);
                return pos + 1;
            } else {
                pos++;
            }
        }
        syntax_assert(false, pos);
        return pos;
    }

    function read_begin_tag(lines, pos) {
        return is_tag(lines, pos, is_begin_tag);
    }

    function read_close_tag(lines, pos) {
        return is_tag(lines, pos, is_close_tag);
    }

    function read_field(objects, fields, content, pos, namespace) {
        if (is_empty(content)) {
            return false;
        } else if (is_close_tag(content)) {
            return true;
        }

        if (content.indexOf('*') !== -1) {
            read_array_field(objects, fields, content, pos, namespace);
        } else {
            read_normal_field(objects, fields, content, pos, false, namespace);
        }
        return false;
    }

    function read_struct(lines, objects, messages, pos) {
        let next_pos;
        const content = lines[pos];
        const match = content.match(/struct\s+([\w_]+)\s*\{+/);
        let name;
        if (match) {
            name = match[1];
            next_pos = pos + 1;
        } else {
            const match2 = content.match(/struct\s+([\w_]+)\s*$/);
            name = syntax_assert(match2 ? match2[1] : null, pos);
            next_pos = read_begin_tag(lines, pos + 1);
        }

        if (objects[name]) {
            throw new Error(`Duplicate object name '${name}' at line ${pos}`);
        }

        const object = {
            name: name,
            fields: {},
            namespace: name
        };
        objects[name] = object;

        pos = next_pos;
        while (pos < lines.length) {
            const sub_match = lines[pos].match(/struct\s+([\w_]+)\s*\{+/) ||
                             lines[pos].match(/struct\s+([\w_]+)\s*$/);
            if (sub_match) {
                const sub_name = sub_match[1];
                lines[pos] = lines[pos].replace(sub_name, name + '_' + sub_name);
                const result = read_struct(lines, objects, messages, pos);
                pos = result.pos;
            } else {
                const close_tag = read_field(objects, object.fields, lines[pos], pos, name);
                if (close_tag) {
                    break;
                } else {
                    pos++;
                }
            }
        }

        pos = read_close_tag(lines, pos);
        return { pos, name };
    }

    function read_message(lines, objects, messages, pos) {
        let next_pos;
        const content = lines[pos];
        let name, id, dest;
        let fullName;

        let match = content.match(/message\s+([\w_.]+)\s+(\d+)\s+\{\s*/);
        if (match) {
            fullName = match[1];
            id = parseInt(match[2], 10);
            // hndle dest.name format (e.g., global.rank.AddressBook)
            const lastDotIndex = fullName.lastIndexOf('.');
            if (lastDotIndex !== -1) {
                dest = fullName.substring(0, lastDotIndex);
                name = fullName.substring(lastDotIndex + 1);
            } else {
                name = fullName;
            }
            next_pos = pos + 1;
        } else {
            match = content.match(/message\s+([\w_.]+)\s+(\d+)\s*$/);
            if (match) {
                fullName = match[1];
                id = parseInt(match[2], 10);
                // Handle dest.name format (e.g., global.rank.AddressBook)
                const lastDotIndex = fullName.lastIndexOf('.');
                if (lastDotIndex !== -1) {
                    dest = fullName.substring(0, lastDotIndex);
                    name = fullName.substring(lastDotIndex + 1);
                } else {
                    name = fullName;
                }
                syntax_assert(name, pos);
                next_pos = read_begin_tag(lines, pos + 1);
            }
        }

        syntax_assert(name, pos);
        id = syntax_assert(parseInt(id, 10), pos);
        syntax_assert(id >= 0, pos);

        for (const key in messages) {
            if (messages[key].id === id) {
                throw new Error(`Duplicate proto id '${id}' at line:${pos}`);
            }
        }

        const message = {
            id: id,
            name: name,
            request: null,
            response: null,
            dest: dest
        };
        messages[name] = message;

        // read request
        pos = next_pos;
        while (pos < lines.length) {
            const content = lines[pos];
            if (!is_empty(content)) {
                if (content.match(/\s*request\s+\{\s*/)) {
                    const new_content = content.replace('request', `struct ${name}_request`);
                    lines[pos] = new_content;
                    const result = read_struct(lines, objects, messages, pos);
                    message.request = result.name;
                    pos = result.pos;
                    break;
                } else if (content.match(/\s*response\s+\{\s*/)) {
                    break;
                } else {
                    syntax_assert(false, pos);
                }
            } else {
                pos++;
            }
        }

        // read response
        while (pos < lines.length) {
            const content = lines[pos];
            if (!is_empty(content)) {
                if (content.match(/\s*response\s+\{\s*/)) {
                    const new_content = content.replace('response', `struct ${name}_response`);
                    lines[pos] = new_content;
                    const result = read_struct(lines, objects, messages, pos);
                    message.response = result.name;
                    pos = result.pos;
                    break;
                } else if (is_close_tag(content)) {
                    break;
                } else {
                    syntax_assert(false, pos);
                }
            } else {
                pos++;
            }
        }

        pos = read_close_tag(lines, pos);
        return pos + 1;
    }

    function read_one_proto(lines, objects, messages, pos) {
        // skip empty lines at the start
        while (pos < lines.length && is_empty(lines[pos])) {
            pos++;
        }

        while (pos < lines.length) {
            const content = lines[pos];
            if (content.indexOf('struct ') !== -1) {
                const result = read_struct(lines, objects, messages, pos);
                pos = result.pos;
            } else if (content.indexOf('message ') !== -1) {
                pos = read_message(lines, objects, messages, pos);
            } else {
                syntax_assert(is_empty(content), pos);
                pos++;
            }
        }
        return pos;
    }

    function create_cobject(version, objects, obj) {
        const object_def = version.get_object(obj.name);
        if (!object_def) {
            const new_obj = new ObjectDef(obj.name);
            version.add_object(new_obj);

            for (const field_name in obj.fields) {
                const field_data = obj.fields[field_name];
                let field_object = null;

                if (field_data.object_names && field_data.object_names.length > 0) {
                    for (let i = 0; i < field_data.object_names.length; i++) {
                        const obj_name = field_data.object_names[i];
                        const nested_obj = objects[obj_name];
                        if (nested_obj) {
                            field_object = create_cobject(version, objects, nested_obj);
                            break;
                        }
                    }
                    if (!field_object) {
                        throw new Error(`Type field '${field_data.object_names[field_data.object_names.length - 1]}' undefined at line:${field_data.pos}`);
                    }
                }

                const field = new Field(
                    field_data.id,
                    field_data.name,
                    field_data.type,
                    field_data.is_array,
                    field_object,
                    field_data.extra
                );
                new_obj.add_field(field);
            }

            return new_obj;
        }
        return object_def;
    }

    function parse(text, compile) {
        const lines = compile_lines(text, compile);
        const version = new Version();
        const objects = {};
        const messages = {};
        let pos = 0;

        while (pos < lines.length) {
            pos = read_one_proto(lines, objects, messages, pos);
        }

        // create objects
        for (const name in objects) {
            const obj = objects[name];
            create_cobject(version, objects, obj);
        }

        // create messages
        for (const name in messages) {
            const msg = messages[name];
            let request_obj = null;
            let response_obj = null;

            if (msg.request) {
                const obj = version.get_object(msg.request);
                if (!obj) {
                    throw new Error(`Request object '${msg.request}' undefined`);
                }
                request_obj = obj;
            }

            if (msg.response) {
                const obj = version.get_object(msg.response);
                if (!obj) {
                    throw new Error(`Response object '${msg.response}' undefined`);
                }
                response_obj = obj;
            }

            const proto = new ProtoDef(msg.name, msg.id, request_obj, response_obj, msg.dest);
            version.add_proto(proto);
        }

        return version;
    }

    return Object.freeze(interface_obj);
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = qproto;
}
