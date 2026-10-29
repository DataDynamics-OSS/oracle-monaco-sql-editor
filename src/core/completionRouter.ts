/**
 * Per-model provider routing.
 *
 * Monaco language providers (completion, signature help, hover …) are
 * registered per *language*, so with several editors on a page (tabs, split
 * views) each with its own metadata source, a single global provider would
 * serve every editor with the last one's data. A router is registered once
 * per language and dispatches each request to the provider attached to that
 * request's model URI, falling back to a default provider for models no
 * editor has claimed.
 */
import type { CancellationToken, Position, editor, languages } from "monaco-editor";

export interface ModelRouter<P> {
  /** Route requests for `modelUri` to `provider`. Returns a detach function. */
  attach(modelUri: string, provider: P): () => void;
  /** Replace the provider used for models with no attached provider. */
  setFallback(provider: P | undefined): void;
  /** The provider for `model` (attached, else the fallback). */
  pick(model: editor.ITextModel): P | undefined;
}

export function createModelRouter<P>(fallback?: P): ModelRouter<P> {
  const byModel = new Map<string, P>();
  let defaultProvider = fallback;
  return {
    attach(modelUri, p) {
      byModel.set(modelUri, p);
      return () => {
        if (byModel.get(modelUri) === p) byModel.delete(modelUri);
      };
    },
    setFallback(p) {
      defaultProvider = p;
    },
    pick(model) {
      return byModel.get(model.uri.toString()) ?? defaultProvider;
    },
  };
}

export interface CompletionRouter extends ModelRouter<languages.CompletionItemProvider> {
  /** The provider to register once with `monaco.languages.registerCompletionItemProvider`. */
  readonly provider: languages.CompletionItemProvider;
}

export function createCompletionRouter(
  triggerCharacters: string[],
  fallback?: languages.CompletionItemProvider,
): CompletionRouter {
  const router = createModelRouter(fallback);
  const provider: languages.CompletionItemProvider = {
    triggerCharacters,
    provideCompletionItems(
      model: editor.ITextModel,
      position: Position,
      context: languages.CompletionContext,
      token: CancellationToken,
    ) {
      const p = router.pick(model);
      return p ? p.provideCompletionItems(model, position, context, token) : { suggestions: [] };
    },
  };
  return { ...router, provider };
}

export interface SignatureHelpRouter extends ModelRouter<languages.SignatureHelpProvider> {
  readonly provider: languages.SignatureHelpProvider;
}

export function createSignatureHelpRouter(
  triggerCharacters: string[],
  retriggerCharacters: string[],
): SignatureHelpRouter {
  const router = createModelRouter<languages.SignatureHelpProvider>();
  const provider: languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: triggerCharacters,
    signatureHelpRetriggerCharacters: retriggerCharacters,
    provideSignatureHelp(model, position, token, context) {
      const p = router.pick(model);
      return p ? p.provideSignatureHelp(model, position, token, context) : null;
    },
  };
  return { ...router, provider };
}

export interface HoverRouter extends ModelRouter<languages.HoverProvider> {
  readonly provider: languages.HoverProvider;
}

export function createHoverRouter(): HoverRouter {
  const router = createModelRouter<languages.HoverProvider>();
  const provider: languages.HoverProvider = {
    provideHover(model, position, token) {
      const p = router.pick(model);
      return p ? p.provideHover(model, position, token) : null;
    },
  };
  return { ...router, provider };
}
