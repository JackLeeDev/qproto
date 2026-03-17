const fs = require('fs');
const path = require('path');
const qproto = require('../js/qproto.js');

// Deep equality check for objects and arrays
function eq(a, b) {
    const ta = typeof a;
    const tb = typeof b;
    if (ta !== tb) {
        return false;
    }
    if (ta !== 'object' || a === null || b === null) {
        return a === b;
    }

    // Both are objects (including arrays)
    const isArrayA = Array.isArray(a);
    const isArrayB = Array.isArray(b);
    if (isArrayA !== isArrayB) {
        return false;
    }

    if (isArrayA) {
        // Compare arrays
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!eq(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }

    // Compare objects
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) {
        return false;
    }

    for (const key of keysA) {
        if (!eq(a[key], b[key])) {
            return false;
        }
    }

    return true;
}

function assert_eq(a, b, typ, field) {
    const desc = `type ${typ.padEnd(15)} field ${field.padEnd(20)} test `;
    const ok = eq(a, b);
    if (ok) {
        console.log(desc + 'success');
    } else {
        throw new Error(desc + 'fail');
    }
}

function assert_field_eq(msg1, msg2, typ, field) {
    assert_eq(msg1[field], msg2[field], typ, field);
}

function load_proto() {
    const protoPath = path.join(__dirname, 'test.proto');
    const ctx = fs.readFileSync(protoPath, 'utf8');
    const version = qproto.parse(ctx);
    qproto.save(version);
}

function run_test() {
    load_proto();

    const msg = {
        reqInt: 101,
        reqIntArray: [101, 102],
        reqString: "str",
        reqStringArray: ["str1", "str2", "str3"],
        reqBinary: Buffer.from("binary"),
        reqBinaryArray: [Buffer.from("binary1"), Buffer.from("binary2"), Buffer.from("binary3"), Buffer.from("binary4")],
        reqDouble: 1.23,
        reqDoubleArray: [1.2, 3.4, 5.6, 7.8],
        reqStruct: { testInt: 200 },
        reqStructArray: [{ testInt: 300 }, { testInt: 600 }],
        reqInnerStruct: { testInt: 700 },
        reqInnerStructArray: [{ testInt: 800 }, { testInt: 900 }]
    };

    const buffer = qproto.encode_request("TestTypes", msg, 200);
    const decoded = qproto.decode_request(buffer);

    console.log('------------------ run tests ------------------\n');

    assert_eq(msg.reqInt, decoded.result.reqInt, "integer", "reqInt");
    assert_eq(msg.reqIntArray, decoded.result.reqIntArray, "integer*", "reqIntArray");

    assert_eq(msg.reqString, decoded.result.reqString, "string", "reqString");
    assert_eq(msg.reqStringArray, decoded.result.reqStringArray, "string*", "reqStringArray");

    // For binary data, compare as strings since Buffer comparison may differ
    assert_eq(msg.reqBinary.toString(), decoded.result.reqBinary.toString(), "bytes", "reqBinary");
    assert_eq(
        msg.reqBinaryArray.map(b => b.toString()),
        decoded.result.reqBinaryArray.map(b => b.toString()),
        "bytes*",
        "reqBinaryArray"
    );

    assert_eq(msg.reqDouble, decoded.result.reqDouble, "double", "reqDouble");
    assert_eq(msg.reqDoubleArray, decoded.result.reqDoubleArray, "double*", "reqDoubleArray");

    assert_eq(msg.reqStruct, decoded.result.reqStruct, "struct", "reqStruct");
    assert_eq(msg.reqStructArray, decoded.result.reqStructArray, "struct*", "reqStructArray");

    assert_eq(msg.reqInnerStruct, decoded.result.reqInnerStruct, "inner_struct", "reqInnerStruct");
    assert_eq(msg.reqInnerStructArray, decoded.result.reqInnerStructArray, "inner_struct*", "reqInnerStructArray");

    assert_eq(decoded.session, 200, "session", "none");
    assert_eq(decoded.dest, "global.test", "forward-address", "none");

    console.log('\n--------------- tests completed ---------------');
}

run_test();
