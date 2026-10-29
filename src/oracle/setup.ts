import type { Monaco } from "@monaco-editor/react";
import type { languages } from "monaco-editor";
import { ORACLE_LANGUAGE_ID, oracleLanguage, oracleLanguageConf } from "./language";
import {
  ORACLE_DARK_THEME,
  ORACLE_LIGHT_THEME,
  oracleDarkTheme,
  oracleLightTheme,
} from "./themes";
import {
  resolveLanguageElements,
  type OracleLanguageElements,
  type OracleVersion,
} from "./keywords";
import {
  ORACLE_TRIGGER_CHARACTERS,
  createOracleCompletionProvider,
  type CompletionOptions,
  type MetadataProvider,
} from "./completion";
import {
  createCompletionRouter,
  createHoverRouter,
  createSignatureHelpRouter,
  type CompletionRouter,
  type HoverRouter,
  type SignatureHelpRouter,
} from "../core/completionRouter";
import {
  ORACLE_SIGNATURE_RETRIGGER_CHARACTERS,
  ORACLE_SIGNATURE_TRIGGER_CHARACTERS,
  createOracleSignatureHelpProvider,
} from "./signatureHelp";
import { createOracleHoverProvider } from "./hover";

export interface SetupOptions extends CompletionOptions {
  /** Override or extend the built-in language elements. */
  languageElements?: Partial<OracleLanguageElements>;
  /** Highest Oracle version whose syntax is enabled. Default "19c". */
  targetVersion?: OracleVersion;
  /** Metadata provider for models no `<OracleEditor>` has claimed. */
  metadataProvider?: MetadataProvider;
}

/**
 * The per-model routers registered for the `oracle` language. Itself the
 * completion router (backward compatible), plus signature help and hover.
 */
export interface OracleRouters extends CompletionRouter {
  signatureHelp: SignatureHelpRouter;
  hover: HoverRouter;
}

// One registration per Monaco instance (the demo and a host app may each load one).
const registrations = new WeakMap<Monaco, OracleRouters>();

/**
 * Register the Oracle language, themes and the per-model routers for
 * completion, signature help and hover with Monaco.
 *
 * Safe to call multiple times: the language, tokenizer and themes register
 * once per Monaco instance (so highlighting uses the elements of the FIRST
 * call), while each call refreshes the fallback providers used by models
 * that no `<OracleEditor>` has attached its own providers to.
 */
export function setupOracle(monaco: Monaco, options: SetupOptions = {}): OracleRouters {
  const elements = resolveLanguageElements(options.languageElements, options.targetVersion);
  const metadata = options.metadataProvider;
  const fallback = createOracleCompletionProvider(monaco, elements, metadata, options);
  const signatureFallback = createOracleSignatureHelpProvider(() => metadata?.signatures);
  const hoverFallback = createOracleHoverProvider(monaco, {
    elements,
    describe: () => metadata?.describe,
    version: () => options.targetVersion,
  });

  const existing = registrations.get(monaco);
  if (existing) {
    existing.setFallback(fallback);
    existing.signatureHelp.setFallback(signatureFallback);
    existing.hover.setFallback(hoverFallback);
    return existing;
  }

  monaco.languages.register({ id: ORACLE_LANGUAGE_ID, aliases: ["Oracle SQL", "PL/SQL"] });

  monaco.languages.setMonarchTokensProvider(ORACLE_LANGUAGE_ID, {
    ...oracleLanguage,
    keywords: [...elements.keywords, ...elements.plsqlKeywords],
    operators: elements.operators,
    builtinFunctions: elements.functions,
    builtinVariables: elements.pseudoColumns,
    typeKeywords: elements.types,
    builtinPackages: elements.builtinPackages,
  } as languages.IMonarchLanguage);

  monaco.languages.setLanguageConfiguration(ORACLE_LANGUAGE_ID, oracleLanguageConf);

  monaco.editor.defineTheme(ORACLE_LIGHT_THEME, oracleLightTheme);
  monaco.editor.defineTheme(ORACLE_DARK_THEME, oracleDarkTheme);

  const completion = createCompletionRouter(ORACLE_TRIGGER_CHARACTERS, fallback);
  const signatureHelp = createSignatureHelpRouter(ORACLE_SIGNATURE_TRIGGER_CHARACTERS, ORACLE_SIGNATURE_RETRIGGER_CHARACTERS);
  const hover = createHoverRouter();
  signatureHelp.setFallback(signatureFallback);
  hover.setFallback(hoverFallback);
  monaco.languages.registerCompletionItemProvider(ORACLE_LANGUAGE_ID, completion.provider);
  monaco.languages.registerSignatureHelpProvider(ORACLE_LANGUAGE_ID, signatureHelp.provider);
  monaco.languages.registerHoverProvider(ORACLE_LANGUAGE_ID, hover.provider);

  const routers: OracleRouters = { ...completion, signatureHelp, hover };
  registrations.set(monaco, routers);
  return routers;
}
