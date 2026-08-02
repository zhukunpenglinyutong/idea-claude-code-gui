package com.github.claudecodegui.remote;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

/**
 * Pure-logic tests for {@link BoundedBodyReader}. No HTTP server.
 */
public class BoundedBodyReaderTest {

    @Test
    public void readsBodyUnderLimit() throws Exception {
        byte[] data = "hello".getBytes();
        byte[] out = BoundedBodyReader.read(new ByteArrayInputStream(data));
        assertEquals("hello", new String(out));
    }

    @Test
    public void readsEmptyBody() throws Exception {
        byte[] out = BoundedBodyReader.read(new ByteArrayInputStream(new byte[0]));
        assertEquals(0, out.length);
    }

    @Test
    public void returnsNullStreamAsEmpty() throws Exception {
        byte[] out = BoundedBodyReader.read(null);
        assertEquals(0, out.length);
    }

    @Test
    public void readsBodyAtExactLimit() throws Exception {
        int cap = RemoteChatLimits.MAX_BODY_BYTES;
        byte[] data = new byte[cap];
        for (int i = 0; i < cap; i++) {
            data[i] = (byte) 'a';
        }
        byte[] out = BoundedBodyReader.read(new ByteArrayInputStream(data));
        assertEquals(cap, out.length);
    }

    @Test
    public void rejectsBodyOverLimit() {
        int cap = RemoteChatLimits.MAX_BODY_BYTES;
        byte[] data = new byte[cap + 10];
        for (int i = 0; i < data.length; i++) {
            data[i] = (byte) 'a';
        }
        try {
            BoundedBodyReader.read(new ByteArrayInputStream(data));
            fail("expected PayloadTooLargeException");
        } catch (PayloadTooLargeException expected) {
            // ok
        } catch (IOException e) {
            fail("unexpected IOException: " + e.getMessage());
        }
    }

    @Test
    public void rejectsBodyOneByteOverLimit() {
        int cap = RemoteChatLimits.MAX_BODY_BYTES;
        byte[] data = new byte[cap + 1];
        for (int i = 0; i < data.length; i++) {
            data[i] = (byte) 'a';
        }
        try {
            BoundedBodyReader.read(new ByteArrayInputStream(data));
            fail("expected PayloadTooLargeException");
        } catch (PayloadTooLargeException expected) {
            // ok
        } catch (IOException e) {
            fail("unexpected IOException: " + e.getMessage());
        }
    }
}
