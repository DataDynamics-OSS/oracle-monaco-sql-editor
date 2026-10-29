/**
 * Monaco signature help (`(` and `,`) and `name =>` argument completions.
 *
 * Built-in SQL functions come from the static table in `signatures.ts`;
 * everything else from a `SignatureSource` (the dictionary metadata
 * provider's `signatures`, backed by ALL_ARGUMENTS).
 */
import type { Monaco } from "@monaco-editor/react";
import type { editor, IRange, languages, Position } from "monaco-editor";
import {
  activeSignature,
  builtinSignatures,
  callAt,
  namedParameterCandidates,
  signatureLabel,
  type CallSite,
  type OracleSignature,
  type SignatureSource,
} from "./signatures";
import { renderIdent } from "./identifiers";
import { docSummary, type OracleLocale } from "./i18n";

export const ORACLE_SIGNATURE_TRIGGER_CHARACTERS = ["(", ","];
export const ORACLE_SIGNATURE_RETRIGGER_CHARACTERS = [")"];

/** Signatures for a call: built-ins first, then the source (unless a built-in matched). */
export async function signaturesForCall(call: CallSite, source?: SignatureSource): Promise<OracleSignature[]> {
  const builtin = builtinSignatures(call);
  if (builtin.length) return builtin;
  if (!source) return [];
  try {
    return await source(call);
  } catch {
    return [];
  }
}

export function createOracleSignatureHelpProvider(
  getSource: () => SignatureSource | undefined,
  getLocale?: () => OracleLocale | undefined,
): languages.SignatureHelpProvider {
  return {
    signatureHelpTriggerCharacters: ORACLE_SIGNATURE_TRIGGER_CHARACTERS,
    signatureHelpRetriggerCharacters: ORACLE_SIGNATURE_RETRIGGER_CHARACTERS,

    async provideSignatureHelp(model: editor.ITextModel, position: Position) {
      const call = callAt(model.getValue(), model.getOffsetAt(position));
      if (!call) return null;
      const sigs = await signaturesForCall(call, getSource());
      if (!sigs.length) return null;
      const active = activeSignature(sigs, call);
      const builtin = builtinSignatures(call).length > 0;
      const locale = getLocale?.();
      return {
        value: {
          signatures: sigs.map((sig) => {
            const { label, parameters } = signatureLabel(sig);
            const doc = (builtin && docSummary(`fn:${sig.name.toUpperCase()}`, locale)) || sig.documentation;
            return {
              label,
              ...(doc ? { documentation: { value: doc } } : {}),
              parameters: parameters.map((range, i) => ({
                label: range,
                ...(sig.parameters[i].optional ? { documentation: "optional" } : {}),
              })),
            };
          }),
          activeSignature: active.signature,
          activeParameter: active.parameter,
        },
        dispose() {},
      };
    },
  };
}

/**
 * `p_name => ` completion items for the argument the caret starts, or [] when
 * the caret is not at an argument start of a call with known parameters.
 * Built-in SQL functions take positional arguments only and get none.
 */
export async function namedArgumentItems(
  monaco: Monaco,
  model: editor.ITextModel,
  position: Position,
  range: IRange,
  source: SignatureSource | undefined,
  typed: string,
): Promise<languages.CompletionItem[]> {
  if (!source) return [];
  const call = callAt(model.getValue(), model.getOffsetAt(position));
  if (!call || !call.atArgStart || call.currentNamed || builtinSignatures(call).length) return [];
  let sigs: OracleSignature[];
  try {
    sigs = await source(call);
  } catch {
    return [];
  }
  return namedParameterCandidates(sigs, call).map((p) => {
    const name = renderIdent(p.name, typed);
    return {
      label: `${name} =>`,
      kind: monaco.languages.CompletionItemKind.Property,
      detail: `parameter${p.mode && p.mode !== "IN" ? ` ${p.mode}` : ""}${p.type ? ` · ${p.type}` : ""}${p.optional ? " · optional" : ""}`,
      insertText: `${name} => `,
      range,
      sortText: `0-${p.optional ? 1 : 0}-${p.name}`,
      command: { id: "editor.action.triggerParameterHints", title: "" },
    };
  });
}
