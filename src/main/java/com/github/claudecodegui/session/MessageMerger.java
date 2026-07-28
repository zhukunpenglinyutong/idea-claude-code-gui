package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Message merger.
 * Merges streaming assistant messages, ensuring previously displayed tool steps are not overwritten.
 */
public class MessageMerger {

    /**
     * Merge streaming assistant messages.
     */
    public JsonObject mergeAssistantMessage(JsonObject existingRaw, JsonObject newRaw) {
        if (newRaw == null) {
            return existingRaw != null ? existingRaw.deepCopy() : null;
        }

        if (existingRaw == null) {
            return newRaw.deepCopy();
        }

        JsonObject merged = existingRaw.deepCopy();

        // Merge top-level fields (except "message")
        for (Map.Entry<String, JsonElement> entry : newRaw.entrySet()) {
            if ("message".equals(entry.getKey())) {
                continue;
            }
            merged.add(entry.getKey(), entry.getValue());
        }

        JsonObject incomingMessage = newRaw.has("message") && newRaw.get("message").isJsonObject()
            ? newRaw.getAsJsonObject("message")
            : null;

        if (incomingMessage == null) {
            return merged;
        }

        JsonObject mergedMessage = merged.has("message") && merged.get("message").isJsonObject()
            ? merged.getAsJsonObject("message")
            : new JsonObject();

        // Copy new metadata (keep latest stop_reason, usage, etc.)
        for (Map.Entry<String, JsonElement> entry : incomingMessage.entrySet()) {
            if ("content".equals(entry.getKey())) {
                continue;
            }
            mergedMessage.add(entry.getKey(), entry.getValue());
        }

        mergeAssistantContentArray(mergedMessage, incomingMessage);
        merged.add("message", mergedMessage);
        return merged;
    }

    /**
     * Merge the content array of assistant messages.
     */
    private void mergeAssistantContentArray(JsonObject targetMessage, JsonObject incomingMessage) {
        JsonArray baseContent = targetMessage.has("content") && targetMessage.get("content").isJsonArray()
            ? targetMessage.getAsJsonArray("content")
            : new JsonArray();

        Map<String, Integer> indexByKey = buildContentIndex(baseContent);
        Set<Integer> consumedUnkeyedIndexes = new HashSet<>();

        JsonArray incomingContent = incomingMessage.has("content") && incomingMessage.get("content").isJsonArray()
            ? incomingMessage.getAsJsonArray("content")
            : null;

        if (incomingContent == null) {
            targetMessage.add("content", baseContent);
            return;
        }

        for (int i = 0; i < incomingContent.size(); i++) {
            JsonElement element = incomingContent.get(i);
            JsonElement elementCopy = element.deepCopy();

            if (element.isJsonObject()) {
                JsonObject block = element.getAsJsonObject();
                String key = getContentBlockKey(block);
                if (key != null && indexByKey.containsKey(key)) {
                    int idx = indexByKey.get(key);
                    baseContent.set(idx, elementCopy);
                    continue;
                } else if (key != null) {
                    baseContent.add(elementCopy);
                    indexByKey.put(key, baseContent.size() - 1);
                    continue;
                } else {
                    int idx = findMatchingUnkeyedBlockIndex(baseContent, block, consumedUnkeyedIndexes);
                    if (idx >= 0) {
                        baseContent.set(idx, mergeUnkeyedBlock(baseContent.get(idx).getAsJsonObject(), block));
                        consumedUnkeyedIndexes.add(idx);
                        continue;
                    }

                    // Fallback: merge with last same-type block instead of adding duplicate
                    int lastSameTypeIdx = findLastSameTypeBlockIndex(baseContent, block);
                    if (lastSameTypeIdx >= 0) {
                        baseContent.set(lastSameTypeIdx,
                                mergeUnkeyedBlock(baseContent.get(lastSameTypeIdx).getAsJsonObject(), block));
                        continue;
                    }
                }
            }

            baseContent.add(elementCopy);
        }

        targetMessage.add("content", baseContent);
    }

    /**
     * Build an index of content blocks by their unique keys.
     */
    private Map<String, Integer> buildContentIndex(JsonArray contentArray) {
        Map<String, Integer> index = new HashMap<>();
        for (int i = 0; i < contentArray.size(); i++) {
            JsonElement element = contentArray.get(i);
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject block = element.getAsJsonObject();
            String key = getContentBlockKey(block);
            if (key != null && !index.containsKey(key)) {
                index.put(key, i);
            }
        }
        return index;
    }

    /**
     * Get the unique key for a content block.
     */
    private String getContentBlockKey(JsonObject block) {
        if (block.has("id") && block.get("id").isJsonPrimitive()) {
            return block.get("id").getAsString();
        }

        if (block.has("tool_use_id") && block.get("tool_use_id").isJsonPrimitive()) {
            return "tool_result:" + block.get("tool_use_id").getAsString();
        }

        return null;
    }

    private int findMatchingUnkeyedBlockIndex(
            JsonArray baseContent,
            JsonObject incomingBlock,
            Set<Integer> consumedUnkeyedIndexes
    ) {
        String incomingType = getContentBlockType(incomingBlock);
        if (incomingType == null) {
            return -1;
        }

        for (int i = 0; i < baseContent.size(); i++) {
            if (consumedUnkeyedIndexes.contains(i)) {
                continue;
            }

            JsonElement existingElement = baseContent.get(i);
            if (!existingElement.isJsonObject()) {
                continue;
            }

            JsonObject existingBlock = existingElement.getAsJsonObject();
            if (getContentBlockKey(existingBlock) != null) {
                continue;
            }

            if (!incomingType.equals(getContentBlockType(existingBlock))) {
                continue;
            }

            if (blocksLikelyRepresentSameSegment(existingBlock, incomingBlock)) {
                return i;
            }
        }

        return -1;
    }

    private JsonObject mergeUnkeyedBlock(JsonObject existingBlock, JsonObject incomingBlock) {
        String type = getContentBlockType(incomingBlock);
        JsonObject merged = incomingBlock.deepCopy();

        if ("text".equals(type)) {
            merged.addProperty("text", preferMoreCompleteContent(
                    getTextContent(existingBlock),
                    getTextContent(incomingBlock)
            ));
            return merged;
        }

        if ("thinking".equals(type)) {
            String thinking = preferMoreCompleteContent(
                    getThinkingContent(existingBlock),
                    getThinkingContent(incomingBlock)
            );
            if (thinking != null && !thinking.isEmpty()) {
                merged.addProperty("thinking", thinking);
                merged.addProperty("text", thinking);
            }
        }

        return merged;
    }

    private boolean blocksLikelyRepresentSameSegment(JsonObject existingBlock, JsonObject incomingBlock) {
        String type = getContentBlockType(incomingBlock);
        if (type == null || !type.equals(getContentBlockType(existingBlock))) {
            return false;
        }

        if ("text".equals(type)) {
            // Text blocks matched across a segment boundary must be strictly
            // prefix-related: two segments separated by a tool_use should share no
            // prefix relation, whereas the lenient suffix-prefix overlap would fire
            // on incidental shared boundaries (code fences, Markdown markers) and
            // wrongly merge a new segment into the previous one.
            return textLooksRelatedStrict(getTextContent(existingBlock), getTextContent(incomingBlock));
        }

        if ("thinking".equals(type)) {
            String existingThinking = getThinkingContent(existingBlock);
            String incomingThinking = getThinkingContent(incomingBlock);
            // During early streaming, thinking content may not yet be populated,
            // so type-based matching alone determines block identity.
            if (existingThinking.isEmpty() || incomingThinking.isEmpty()) {
                return true;
            }
            return textLooksRelated(existingThinking, incomingThinking);
        }

        return existingBlock.equals(incomingBlock);
    }

    private int findLastSameTypeBlockIndex(JsonArray baseContent, JsonObject incomingBlock) {
        String incomingType = getContentBlockType(incomingBlock);
        if (incomingType == null) {
            return -1;
        }
        // Only consider the tail of baseContent — do not cross keyed blocks
        // (tool_use, tool_result) to avoid merging content from different segments.
        // E.g., [text_1, tool_use, text_2] should NOT merge text_2 into text_1.
        for (int i = baseContent.size() - 1; i >= 0; i--) {
            JsonElement element = baseContent.get(i);
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject existingBlock = element.getAsJsonObject();
            // Stop scanning if we hit a keyed block (tool_use, tool_result)
            if (getContentBlockKey(existingBlock) != null) {
                break;
            }
            // Honour the same segment boundary as the primary matcher: a same-type
            // tail block that is NOT prefix-related to the incoming block belongs to
            // a different segment, so do not merge into it - fall through to adding
            // the incoming block as a new one instead.
            if (incomingType.equals(getContentBlockType(existingBlock))
                    && blocksLikelyRepresentSameSegment(existingBlock, incomingBlock)) {
                return i;
            }
        }
        return -1;
    }

    private String getContentBlockType(JsonObject block) {
        return block.has("type") && !block.get("type").isJsonNull()
                ? block.get("type").getAsString()
                : null;
    }

    private String getTextContent(JsonObject block) {
        return block.has("text") && !block.get("text").isJsonNull()
                ? block.get("text").getAsString()
                : "";
    }

    private String getThinkingContent(JsonObject block) {
        if (block.has("thinking") && !block.get("thinking").isJsonNull()) {
            return block.get("thinking").getAsString();
        }
        return getTextContent(block);
    }

    // Whether two non-empty texts are equal or one is a prefix of the other:
    // the "same segment, possibly grown" relation shared by the strict text
    // check and the lenient thinking check's prefix stage.
    private boolean isPrefixRelated(String existing, String incoming) {
        return existing.equals(incoming)
                || existing.startsWith(incoming)
                || incoming.startsWith(existing);
    }

    // Strict prefix-only relatedness for text blocks across segments. Omits the
    // suffix-prefix overlap that textLooksRelated keeps for fragmented thinking:
    // for text, overlap frequently fires on incidental shared boundaries (code
    // fences, Markdown markers) between two segments separated by a tool_use,
    // wrongly merging a new segment into the previous one.
    private boolean textLooksRelatedStrict(String existingText, String incomingText) {
        String existing = existingText != null ? existingText : "";
        String incoming = incomingText != null ? incomingText : "";
        // isPrefixRelated already treats an empty string as a prefix of any string,
        // so an empty text block and a non-empty one are the same segment (the empty
        // one is the segment's leading edge before content arrives). This lets a
        // later, fuller snapshot fill an empty placeholder instead of duplicating
        // it, mirroring the thinking branch's empty-is-same-segment rule.
        return isPrefixRelated(existing, incoming);
    }

    private boolean textLooksRelated(String existingText, String incomingText) {
        String existing = existingText != null ? existingText : "";
        String incoming = incomingText != null ? incomingText : "";

        if (existing.isEmpty() || incoming.isEmpty()) {
            return existing.isEmpty() && incoming.isEmpty();
        }

        if (isPrefixRelated(existing, incoming)) {
            return true;
        }

        // Check suffix-prefix overlap (streaming may produce partial overlaps)
        int maxOverlap = Math.min(existing.length(), incoming.length());
        maxOverlap = Math.min(maxOverlap, 200);
        int eLen = existing.length();
        for (int overlap = maxOverlap; overlap > 0; overlap--) {
            if (existing.regionMatches(eLen - overlap, incoming, 0, overlap)) {
                return true;
            }
        }

        return false;
    }

    private String preferMoreCompleteContent(String existingText, String incomingText) {
        String existing = existingText != null ? existingText : "";
        String incoming = incomingText != null ? incomingText : "";

        if (incoming.isEmpty()) {
            return existing;
        }
        if (existing.isEmpty()) {
            return incoming;
        }
        if (incoming.startsWith(existing)) {
            return incoming;
        }
        if (existing.startsWith(incoming)) {
            return existing;
        }
        return incoming.length() >= existing.length() ? incoming : existing;
    }
}
