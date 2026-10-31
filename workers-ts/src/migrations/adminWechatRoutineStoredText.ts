/** Byte-preserving counterpart of parseWechatRoutineStoredText. PostgreSQL text
 * cannot contain NUL, and jsonb/text JSON decoders reject escaped NUL. Decode
 * JSON strings directly into bytea instead. Installation and the final
 * maintenance owner belong to the explicit Routine commissioning transaction. */
export const ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION = 'cinashop_wechat_routine_text_bytes_v1';
export const ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE = `public.${ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION}(text)`;

export const ADMIN_WECHAT_ROUTINE_STORED_TEXT_BODY = String.raw`DECLARE
  raw_length integer := pg_catalog.char_length(p_raw);
  cursor_position integer := 1;
  first_position integer;
  codepoint integer;
  low_surrogate integer;
  escape_name text;
  hex_digits text;
  hex_bytes bytea;
  piece bytea;
  output_bytes bytea := pg_catalog.decode('', 'hex');
  canonical_length integer := 2;
BEGIN
  IF raw_length > 5000 THEN RETURN NULL; END IF;

  -- JSON.parse accepts only these four whitespace codepoints around JSON.
  WHILE cursor_position <= raw_length AND pg_catalog.ascii(pg_catalog.substr(p_raw, cursor_position, 1)) IN (9, 10, 13, 32) LOOP
    cursor_position := cursor_position + 1;
  END LOOP;
  IF pg_catalog.substr(p_raw, cursor_position, 1) = '"' THEN
    cursor_position := cursor_position + 1;
    WHILE cursor_position <= raw_length LOOP
      codepoint := pg_catalog.ascii(pg_catalog.substr(p_raw, cursor_position, 1));
      IF codepoint = 34 THEN
        cursor_position := cursor_position + 1;
        WHILE cursor_position <= raw_length AND pg_catalog.ascii(pg_catalog.substr(p_raw, cursor_position, 1)) IN (9, 10, 13, 32) LOOP
          cursor_position := cursor_position + 1;
        END LOOP;
        IF cursor_position <= raw_length THEN RETURN NULL; END IF;
        RETURN output_bytes;
      ELSIF codepoint = 92 THEN
        cursor_position := cursor_position + 1;
        IF cursor_position > raw_length THEN RETURN NULL; END IF;
        escape_name := pg_catalog.substr(p_raw, cursor_position, 1);
        IF escape_name = 'u' THEN
          hex_digits := pg_catalog.substr(p_raw, cursor_position + 1, 4);
          IF pg_catalog.char_length(hex_digits) <> 4 OR hex_digits COLLATE "C" !~ '^[0-9a-fA-F]{4}$' THEN RETURN NULL; END IF;
          hex_bytes := pg_catalog.decode(hex_digits, 'hex');
          codepoint := pg_catalog.get_byte(hex_bytes, 0) * 256 + pg_catalog.get_byte(hex_bytes, 1);
          cursor_position := cursor_position + 5;
          IF codepoint BETWEEN 55296 AND 56319 THEN
            IF pg_catalog.ascii(pg_catalog.substr(p_raw, cursor_position, 1)) <> 92
              OR pg_catalog.substr(p_raw, cursor_position + 1, 1) <> 'u' THEN RETURN NULL; END IF;
            hex_digits := pg_catalog.substr(p_raw, cursor_position + 2, 4);
            IF pg_catalog.char_length(hex_digits) <> 4 OR hex_digits COLLATE "C" !~ '^[0-9a-fA-F]{4}$' THEN RETURN NULL; END IF;
            hex_bytes := pg_catalog.decode(hex_digits, 'hex');
            low_surrogate := pg_catalog.get_byte(hex_bytes, 0) * 256 + pg_catalog.get_byte(hex_bytes, 1);
            IF low_surrogate NOT BETWEEN 56320 AND 57343 THEN RETURN NULL; END IF;
            codepoint := 65536 + (codepoint - 55296) * 1024 + low_surrogate - 56320;
            cursor_position := cursor_position + 6;
          ELSIF codepoint BETWEEN 56320 AND 57343 THEN
            RETURN NULL;
          END IF;
        ELSE
          codepoint := CASE escape_name
            WHEN '"' THEN 34 WHEN '/' THEN 47 WHEN 'b' THEN 8 WHEN 'f' THEN 12
            WHEN 'n' THEN 10 WHEN 'r' THEN 13 WHEN 't' THEN 9
            ELSE CASE WHEN pg_catalog.ascii(escape_name) = 92 THEN 92 ELSE NULL END END;
          IF codepoint IS NULL THEN RETURN NULL; END IF;
          cursor_position := cursor_position + 1;
        END IF;
      ELSE
        IF codepoint < 32 THEN RETURN NULL; END IF;
        cursor_position := cursor_position + 1;
      END IF;

      -- This second bound is also enforced by wechatRoutineStoredValue after
      -- decoding: JSON.stringify expands controls, quotes and backslashes.
      canonical_length := canonical_length + CASE
        WHEN codepoint IN (8, 9, 10, 12, 13, 34, 92) THEN 2
        WHEN codepoint < 32 THEN 6 ELSE 1 END;
      IF canonical_length > 5000 THEN RETURN NULL; END IF;

      -- Assemble UTF-8 without chr(0) or a PostgreSQL text intermediate. This
      -- includes U+0000, supplementary pairs and the full Unicode scalar range.
      IF codepoint < 128 THEN
        piece := pg_catalog.set_byte(pg_catalog.decode('00', 'hex'), 0, codepoint);
      ELSIF codepoint < 2048 THEN
        piece := pg_catalog.set_byte(pg_catalog.set_byte(pg_catalog.decode('0000', 'hex'),
          0, 192 + (codepoint >> 6)), 1, 128 + (codepoint & 63));
      ELSIF codepoint < 65536 THEN
        piece := pg_catalog.set_byte(pg_catalog.set_byte(pg_catalog.set_byte(pg_catalog.decode('000000', 'hex'),
          0, 224 + (codepoint >> 12)), 1, 128 + ((codepoint >> 6) & 63)), 2, 128 + (codepoint & 63));
      ELSE
        piece := pg_catalog.set_byte(pg_catalog.set_byte(pg_catalog.set_byte(pg_catalog.set_byte(pg_catalog.decode('00000000', 'hex'),
          0, 240 + (codepoint >> 18)), 1, 128 + ((codepoint >> 12) & 63)),
          2, 128 + ((codepoint >> 6) & 63)), 3, 128 + (codepoint & 63));
      END IF;
      output_bytes := output_bytes || piece;
    END LOOP;
    RETURN NULL; -- Unterminated JSON string.
  END IF;

  -- The malformed-import prefix guard uses ECMAScript \s, which is wider
  -- than JSON whitespace and deliberately excludes U+0085 and U+180E.
  first_position := 1;
  WHILE first_position <= raw_length LOOP
    codepoint := pg_catalog.ascii(pg_catalog.substr(p_raw, first_position, 1));
    EXIT WHEN NOT (codepoint IN (9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
      OR codepoint BETWEEN 8192 AND 8202);
    first_position := first_position + 1;
  END LOOP;
  IF pg_catalog.substr(p_raw, first_position, 1) IN ('[', '{', '"') THEN RETURN NULL; END IF;
  -- Only validation is used: never cast/decode JSON into jsonb or text. Arrays
  -- and objects were already rejected, including deeply nested imports.
  IF pg_catalog.pg_input_is_valid(p_raw, 'pg_catalog.json') THEN RETURN NULL; END IF;

  cursor_position := 1;
  WHILE cursor_position <= raw_length LOOP
    codepoint := pg_catalog.ascii(pg_catalog.substr(p_raw, cursor_position, 1));
    canonical_length := canonical_length + CASE
      WHEN codepoint IN (8, 9, 10, 12, 13, 34, 92) THEN 2
      WHEN codepoint < 32 THEN 6 ELSE 1 END;
    IF canonical_length > 5000 THEN RETURN NULL; END IF;
    cursor_position := cursor_position + 1;
  END LOOP;
  RETURN pg_catalog.convert_to(p_raw, 'UTF8');
END`;

export const ADMIN_WECHAT_ROUTINE_STORED_TEXT_SQL = `
CREATE FUNCTION public.${ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION}(p_raw text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog
AS $wechat_routine_text_bytes$${ADMIN_WECHAT_ROUTINE_STORED_TEXT_BODY}$wechat_routine_text_bytes$;
REVOKE ALL ON FUNCTION ${ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE} FROM PUBLIC;
`;
