package com.github.claudecodegui.pet;

import org.junit.Test;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Iterator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class CodexPetImageSupportTest {

    @Test
    public void readsCanonicalPetdexPngDimensions() {
        byte[] bytes = pngHeader(1536, 1872);

        String mimeType = CodexPetImageSupport.detectMimeType(Path.of("sprite.png"), bytes);
        CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(mimeType, bytes);

        assertEquals("image/png", mimeType);
        assertNotNull(dimensions);
        assertEquals(1536, dimensions.getWidth());
        assertEquals(1872, dimensions.getHeight());
        assertTrue(CodexPetImageSupport.isCanonicalPetdexSheet(dimensions));
    }

    @Test
    public void readsVp8xWebpDimensionsWithoutDecodingImage() {
        byte[] bytes = vp8xHeader(1536, 2288);

        String mimeType = CodexPetImageSupport.detectMimeType(Path.of("sprite.webp"), bytes);
        CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(mimeType, bytes);

        assertEquals("image/webp", mimeType);
        assertNotNull(dimensions);
        assertEquals(1536, dimensions.getWidth());
        assertEquals(2288, dimensions.getHeight());
        assertTrue(CodexPetImageSupport.isCanonicalPetdexSheet(dimensions));
    }

    @Test
    public void rejectsOversizedAndWrongGridImages() {
        CodexPetImageSupport.ImageDimensions oversized =
                new CodexPetImageSupport.ImageDimensions(5000, 5000);
        CodexPetImageSupport.ImageDimensions excessivePixels =
                new CodexPetImageSupport.ImageDimensions(4096, 4096);
        CodexPetImageSupport.ImageDimensions wrongGrid =
                new CodexPetImageSupport.ImageDimensions(1600, 1872);

        assertFalse(CodexPetImageSupport.hasSafeDimensions(oversized));
        assertFalse(CodexPetImageSupport.hasSafeDimensions(excessivePixels));
        assertFalse(CodexPetImageSupport.isCanonicalPetdexSheet(wrongGrid));
    }

    @Test
    public void rejectsGifBeyondFrameBudget() throws Exception {
        byte[] safeGif = animatedGif(2);
        byte[] excessiveGif = animatedGif(CodexPetImageSupport.MAX_ANIMATED_FRAMES + 1);

        assertTrue(CodexPetImageSupport.hasSafeFrameBudget("image/gif", safeGif));
        assertFalse(CodexPetImageSupport.hasSafeFrameBudget("image/gif", excessiveGif));
    }

    @Test
    public void bundledImageIoProviderDecodesWebp() throws Exception {
        byte[] onePixelWebp = Base64.getDecoder().decode(
                "UklGRrYAAABXRUJQVlA4IKoAAACwEACdASoAAQABPm02mUmCAoAIANiWlu4XaxHtwAABPYB77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJwoAP7/Qwv//hyp9O3sf//Ys5bAsQAAAAAAAAAAAA==");

        assertNotNull(ImageIO.read(new ByteArrayInputStream(onePixelWebp)));
    }

    private static byte[] pngHeader(int width, int height) {
        byte[] bytes = new byte[24];
        bytes[0] = (byte) 0x89;
        bytes[1] = 0x50;
        bytes[2] = 0x4e;
        bytes[3] = 0x47;
        bytes[4] = 0x0d;
        bytes[5] = 0x0a;
        bytes[6] = 0x1a;
        bytes[7] = 0x0a;
        writeBigEndianInt(bytes, 16, width);
        writeBigEndianInt(bytes, 20, height);
        return bytes;
    }

    private static byte[] vp8xHeader(int width, int height) {
        byte[] bytes = new byte[30];
        writeAscii(bytes, 0, "RIFF");
        writeAscii(bytes, 8, "WEBP");
        writeAscii(bytes, 12, "VP8X");
        writeLittleEndian24(bytes, 24, width - 1);
        writeLittleEndian24(bytes, 27, height - 1);
        return bytes;
    }

    private static byte[] animatedGif(int frameCount) throws Exception {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("gif");
        ImageWriter writer = writers.next();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ImageOutputStream output = ImageIO.createImageOutputStream(bytes)) {
            writer.setOutput(output);
            writer.prepareWriteSequence(null);
            BufferedImage frame = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB);
            for (int index = 0; index < frameCount; index++) {
                writer.writeToSequence(new IIOImage(frame, null, null), writer.getDefaultWriteParam());
            }
            writer.endWriteSequence();
        } finally {
            writer.dispose();
        }
        return bytes.toByteArray();
    }

    private static void writeAscii(byte[] bytes, int offset, String value) {
        for (int i = 0; i < value.length(); i++) {
            bytes[offset + i] = (byte) value.charAt(i);
        }
    }

    private static void writeBigEndianInt(byte[] bytes, int offset, int value) {
        bytes[offset] = (byte) (value >>> 24);
        bytes[offset + 1] = (byte) (value >>> 16);
        bytes[offset + 2] = (byte) (value >>> 8);
        bytes[offset + 3] = (byte) value;
    }

    private static void writeLittleEndian24(byte[] bytes, int offset, int value) {
        bytes[offset] = (byte) value;
        bytes[offset + 1] = (byte) (value >>> 8);
        bytes[offset + 2] = (byte) (value >>> 16);
    }
}
