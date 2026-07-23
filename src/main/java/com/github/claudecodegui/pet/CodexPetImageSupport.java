package com.github.claudecodegui.pet;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Iterator;
import java.util.Locale;

/** Lightweight signature and dimension checks for local and Petdex pet images. */
public final class CodexPetImageSupport {

    public static final int PETDEX_FRAME_WIDTH = 192;
    public static final int PETDEX_FRAME_HEIGHT = 208;
    public static final int PETDEX_COLUMNS = 8;
    public static final int MIN_PETDEX_ROWS = 9;
    public static final int MAX_IMAGE_DIMENSION = 4096;
    public static final long MAX_IMAGE_PIXELS = 6_500_000L;
    public static final int MAX_ANIMATED_FRAMES = 240;
    public static final long MAX_ANIMATED_TOTAL_PIXELS = 32_000_000L;
    private static final byte[] PNG_SIGNATURE = {
        (byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    };

    private CodexPetImageSupport() {
    }

    public static String detectMimeType(Path path, byte[] bytes) {
        if (path == null || path.getFileName() == null || bytes == null) {
            return null;
        }
        String fileName = path.getFileName().toString().toLowerCase(Locale.ROOT);
        if (fileName.endsWith(".png") && startsWith(bytes, PNG_SIGNATURE)) {
            return "image/png";
        }
        if ((fileName.endsWith(".jpg") || fileName.endsWith(".jpeg"))
                && startsWith(bytes, new byte[]{(byte) 0xff, (byte) 0xd8, (byte) 0xff})) {
            return "image/jpeg";
        }
        if (fileName.endsWith(".gif")
                && (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a")))) {
            return "image/gif";
        }
        if (fileName.endsWith(".webp") && isWebp(bytes)) {
            return "image/webp";
        }
        return null;
    }

    public static ImageDimensions readDimensions(String mimeType, byte[] bytes) {
        if (mimeType == null || bytes == null) {
            return null;
        }
        switch (mimeType) {
            case "image/png":
                return readPngDimensions(bytes);
            case "image/gif":
                return readGifDimensions(bytes);
            case "image/webp":
                return readWebpDimensions(bytes);
            case "image/jpeg":
                return readJpegDimensions(bytes);
            default:
                return null;
        }
    }

    public static boolean hasSafeDimensions(ImageDimensions dimensions) {
        return dimensions != null
                && dimensions.width > 0
                && dimensions.height > 0
                && dimensions.width <= MAX_IMAGE_DIMENSION
                && dimensions.height <= MAX_IMAGE_DIMENSION
                && (long) dimensions.width * dimensions.height <= MAX_IMAGE_PIXELS;
    }

    public static boolean hasSafeFrameBudget(String mimeType, byte[] bytes) {
        if (!"image/gif".equals(mimeType)) {
            return true;
        }
        if (bytes == null || bytes.length == 0) {
            return false;
        }
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            if (input == null) {
                return false;
            }
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) {
                return false;
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, false, true);
                int frameCount = reader.getNumImages(true);
                if (frameCount <= 0 || frameCount > MAX_ANIMATED_FRAMES) {
                    return false;
                }
                long totalPixels = 0L;
                for (int frame = 0; frame < frameCount; frame++) {
                    int width = reader.getWidth(frame);
                    int height = reader.getHeight(frame);
                    if (width <= 0 || height <= 0
                            || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
                        return false;
                    }
                    totalPixels += (long) width * height;
                    if (totalPixels > MAX_ANIMATED_TOTAL_PIXELS) {
                        return false;
                    }
                }
                return true;
            } finally {
                reader.dispose();
            }
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    public static boolean isCanonicalPetdexSheet(ImageDimensions dimensions) {
        return dimensions != null
                && dimensions.width == PETDEX_FRAME_WIDTH * PETDEX_COLUMNS
                && dimensions.height >= PETDEX_FRAME_HEIGHT * MIN_PETDEX_ROWS
                && dimensions.height % PETDEX_FRAME_HEIGHT == 0
                && dimensions.height <= MAX_IMAGE_DIMENSION;
    }

    private static ImageDimensions readPngDimensions(byte[] bytes) {
        if (bytes.length < 24 || !startsWith(bytes, PNG_SIGNATURE)) {
            return null;
        }
        return dimensions(readIntBigEndian(bytes, 16), readIntBigEndian(bytes, 20));
    }

    private static ImageDimensions readGifDimensions(byte[] bytes) {
        if (bytes.length < 10) {
            return null;
        }
        return dimensions(readUnsignedShortLittleEndian(bytes, 6), readUnsignedShortLittleEndian(bytes, 8));
    }

    private static ImageDimensions readWebpDimensions(byte[] bytes) {
        if (!isWebp(bytes) || bytes.length < 30) {
            return null;
        }
        String chunk = new String(bytes, 12, 4, StandardCharsets.US_ASCII);
        if ("VP8X".equals(chunk)) {
            return dimensions(1 + readUnsigned24LittleEndian(bytes, 24),
                    1 + readUnsigned24LittleEndian(bytes, 27));
        }
        if ("VP8L".equals(chunk) && bytes.length >= 25 && (bytes[20] & 0xff) == 0x2f) {
            int b1 = bytes[21] & 0xff;
            int b2 = bytes[22] & 0xff;
            int b3 = bytes[23] & 0xff;
            int b4 = bytes[24] & 0xff;
            int width = 1 + b1 + ((b2 & 0x3f) << 8);
            int height = 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10);
            return dimensions(width, height);
        }
        if ("VP8 ".equals(chunk) && bytes.length >= 30
                && (bytes[23] & 0xff) == 0x9d
                && (bytes[24] & 0xff) == 0x01
                && (bytes[25] & 0xff) == 0x2a) {
            int width = readUnsignedShortLittleEndian(bytes, 26) & 0x3fff;
            int height = readUnsignedShortLittleEndian(bytes, 28) & 0x3fff;
            return dimensions(width, height);
        }
        return null;
    }

    private static ImageDimensions readJpegDimensions(byte[] bytes) {
        if (bytes.length < 4 || (bytes[0] & 0xff) != 0xff || (bytes[1] & 0xff) != 0xd8) {
            return null;
        }
        int offset = 2;
        while (offset + 3 < bytes.length) {
            if ((bytes[offset] & 0xff) != 0xff) {
                offset++;
                continue;
            }
            int marker = bytes[offset + 1] & 0xff;
            offset += 2;
            if (marker == 0xd8 || marker == 0xd9 || marker == 0x01) {
                continue;
            }
            if (offset + 1 >= bytes.length) {
                return null;
            }
            int segmentLength = ((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff);
            if (segmentLength < 2 || offset + segmentLength > bytes.length) {
                return null;
            }
            if (isStartOfFrame(marker) && segmentLength >= 7) {
                int height = ((bytes[offset + 3] & 0xff) << 8) | (bytes[offset + 4] & 0xff);
                int width = ((bytes[offset + 5] & 0xff) << 8) | (bytes[offset + 6] & 0xff);
                return dimensions(width, height);
            }
            offset += segmentLength;
        }
        return null;
    }

    private static boolean isStartOfFrame(int marker) {
        return marker >= 0xc0 && marker <= 0xcf
                && marker != 0xc4 && marker != 0xc8 && marker != 0xcc;
    }

    private static boolean isWebp(byte[] bytes) {
        return bytes.length >= 16
                && startsWith(bytes, ascii("RIFF"))
                && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P';
    }

    private static ImageDimensions dimensions(int width, int height) {
        return width > 0 && height > 0 ? new ImageDimensions(width, height) : null;
    }

    private static int readIntBigEndian(byte[] bytes, int offset) {
        if (offset < 0 || offset + 4 > bytes.length) {
            return -1;
        }
        return ((bytes[offset] & 0xff) << 24)
                | ((bytes[offset + 1] & 0xff) << 16)
                | ((bytes[offset + 2] & 0xff) << 8)
                | (bytes[offset + 3] & 0xff);
    }

    private static int readUnsignedShortLittleEndian(byte[] bytes, int offset) {
        if (offset < 0 || offset + 2 > bytes.length) {
            return -1;
        }
        return (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8);
    }

    private static int readUnsigned24LittleEndian(byte[] bytes, int offset) {
        if (offset < 0 || offset + 3 > bytes.length) {
            return -1;
        }
        return (bytes[offset] & 0xff)
                | ((bytes[offset + 1] & 0xff) << 8)
                | ((bytes[offset + 2] & 0xff) << 16);
    }

    private static byte[] ascii(String value) {
        return value.getBytes(StandardCharsets.US_ASCII);
    }

    private static boolean startsWith(byte[] bytes, byte[] signature) {
        if (bytes.length < signature.length) {
            return false;
        }
        for (int i = 0; i < signature.length; i++) {
            if (bytes[i] != signature[i]) {
                return false;
            }
        }
        return true;
    }

    public static final class ImageDimensions {
        private final int width;
        private final int height;

        public ImageDimensions(int width, int height) {
            this.width = width;
            this.height = height;
        }

        public int getWidth() {
            return width;
        }

        public int getHeight() {
            return height;
        }
    }
}
