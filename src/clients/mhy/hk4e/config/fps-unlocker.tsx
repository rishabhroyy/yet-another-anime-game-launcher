import {
  Box,
  Checkbox,
  FormControl,
  FormLabel,
  Input,
  InputGroup,
  VStack,
} from "@hope-ui/solid";
import { createEffect, createSignal } from "solid-js";
import type { Locale } from "@locale";
import { assertValueDefined, getKey, setKey } from "@utils";
import { Config, NOOP } from "@config/config-def";

declare module "@config/config-def" {
  interface Config {
    hk4eFpsUnlocker: boolean;
    hk4eFpsUnlockerTarget: string;
  }
}

const CONFIG_KEY_ENABLED = "config_hk4e_fps_unlocker_enabled";
const CONFIG_KEY_TARGET = "config_hk4e_fps_unlocker_target";

export async function createHK4EFpsUnlockerConfig({
  config,
}: {
  config: Partial<Config>;
  locale: Locale;
}) {
  try {
    config.hk4eFpsUnlocker = (await getKey(CONFIG_KEY_ENABLED)) == "true";
  } catch {
    config.hk4eFpsUnlocker = false;
  }

  try {
    config.hk4eFpsUnlockerTarget = await getKey(CONFIG_KEY_TARGET);
  } catch {
    config.hk4eFpsUnlockerTarget = "120";
  }

  const [enabled, setEnabled] = createSignal(config.hk4eFpsUnlocker);
  const [target, setTarget] = createSignal(config.hk4eFpsUnlockerTarget);

  async function onSave(apply: boolean) {
    assertValueDefined(config.hk4eFpsUnlocker);
    assertValueDefined(config.hk4eFpsUnlockerTarget);
    if (!apply) {
      setEnabled(config.hk4eFpsUnlocker);
      setTarget(config.hk4eFpsUnlockerTarget);
      return NOOP;
    }
    if (
      config.hk4eFpsUnlocker == enabled() &&
      config.hk4eFpsUnlockerTarget == target()
    ) {
      return NOOP;
    }
    config.hk4eFpsUnlocker = enabled();
    config.hk4eFpsUnlockerTarget = target();
    await setKey(CONFIG_KEY_ENABLED, config.hk4eFpsUnlocker ? "true" : "false");
    await setKey(CONFIG_KEY_TARGET, config.hk4eFpsUnlockerTarget);
    return NOOP;
  }

  createEffect(() => {
    enabled();
    target();
    onSave(true);
  });

  return [
    function UI() {
      return (
        <FormControl>
          <FormLabel>FPS Unlocker</FormLabel>
          <VStack spacing={4} alignItems="stretch">
            <Box>
              <Checkbox
                checked={enabled()}
                onChange={() => setEnabled(x => !x)}
                size="md"
              >
                Enabled
              </Checkbox>
            </Box>
            <InputGroup>
              <Input
                type="number"
                min="1"
                step="1"
                value={target()}
                onChange={e => setTarget(e.currentTarget.value)}
              />
            </InputGroup>
          </VStack>
        </FormControl>
      );
    },
  ] as const;
}
