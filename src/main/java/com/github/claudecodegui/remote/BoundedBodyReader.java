package com.github.claudecodegui.remote;

import java.io.IOException;
import java.io.InputStream;

/**
 * Reads an HTTP request body with a hard byte cap.
 *
 * <p>The body is never read fully into memory before the cap is checked: the
 * reader streams in chunks and aborts with {@link PayloadTooLargeException} as
 * soon as {@link RemoteChatLimits#MAX_BODY_BYTES} is exceeded. This prevents a
 * malicious or buggy local client from exhausting heap by posting an enormous
 * body.
 *
 * <p>Pure I/O logic (no IntelliJ dependency), so it is unit-testable with a
 * {@link java.io.ByteArrayInputStream}.
 */
public final class BoundedBodyReader {

    private BoundedBodyReader() {
    }

    /**
     * Read up to {@link RemoteChatLimits#MAX_BODY_BYTES} bytes from the stream.
     *
     * @param in the request body stream; not closed by this method
     * @return the body bytes, at most {@code MAX_BODY_BYTES} long
     * @throws PayloadTooLargeException if the stream has more bytes than the cap
     * @throws IOException              on a read error
     */
    public static byte[] read(InputStream in) throws PayloadTooLargeException, IOException {
        return read(in, RemoteChatLimits.MAX_BODY_BYTES);
    }

    /**
     * Read up to {@code cap} bytes from the stream, aborting with
     * {@link PayloadTooLargeException} as soon as the cap is exceeded.
     *
     * @param in  the request body stream; not closed by this method
     * @param cap the maximum number of bytes accepted
     * @return the body bytes, at most {@code cap} long
     * @throws PayloadTooLargeException if the stream has more bytes than the cap
     * @throws IOException              on a read error
     */
    public static byte[] read(InputStream in, int cap) throws PayloadTooLargeException, IOException {
        if (in == null) {
            return new byte[0];
        }
        // One extra byte of headroom detects "exactly at cap + more" vs "exactly at cap".
        byte[] buf = new byte[cap + 1];
        int read = 0;
        int n;
        while (read < buf.length && (n = in.read(buf, read, buf.length - read)) != -1) {
            read += n;
        }
        if (read > cap) {
            throw new PayloadTooLargeException(
                    "Request body exceeds " + cap + " bytes");
        }
        if (read == buf.length) {
            // buf.length == cap + 1; reaching here means exactly cap+1 bytes were
            // read, i.e. the body is at least one byte over the cap.
            throw new PayloadTooLargeException(
                    "Request body exceeds " + cap + " bytes");
        }
        if (read == cap) {
            // Exactly at the cap is allowed only if the stream is now exhausted.
            // Peek: if there is one more byte, the body is too large.
            int extra = in.read();
            if (extra != -1) {
                throw new PayloadTooLargeException(
                        "Request body exceeds " + cap + " bytes");
            }
        }
        byte[] result = new byte[read];
        System.arraycopy(buf, 0, result, 0, read);
        return result;
    }
}
