import {ActorQueryOperationBgpLeftDeepSmallest} from "@comunica/actor-query-operation-bgp-left-deep-smallest";
import {
  ActorQueryOperation,
  ActorQueryOperationTypedMediated,
  Bindings,
  BindingsStream,
  IActorQueryOperationOutputBindings,
  IActorQueryOperationTypedMediatedArgs,
  IPatternBindings,
} from "@comunica/bus-query-operation";
import {DataSources, getDataSourceValue, IDataSource,
  KEY_CONTEXT_SOURCES} from "@comunica/bus-rdf-resolve-quad-pattern";
import {ActionContext, IActorTest} from "@comunica/core";
import {PromiseProxyIterator} from "asynciterator-promiseproxy";
import {RoundRobinUnionIterator} from "asynciterator-union";
import * as RDF from "rdf-js";
import {termToString} from "rdf-string";
import {getNamedNodes, getTerms, getVariables, QUAD_TERM_NAMES} from "rdf-terms";
import {Algebra} from "sparqlalgebrajs";

/**
 * A comunica BGP Traversal Query Operation Actor.
 *
 * It first determines isolated connected graphs.
 * For each of the connected graphs, it orders triple patterns in BGPs by the following priority:
 * 1. dependency-respecting: for each (non-first) pattern, at least one variable must occur in a preceding pattern.
 * 2. seed: try to make the first pattern contain a source URI.
 * 3. no vocab seed: avoid first triple pattern with vocab URI (variable predicate,
 *    or variable objects with rdf:type predicate)
 * 4. filtering: patterns only containing variables also contained in preceding triple patterns
 *    are placed as soon as possible.
 *
 * It does this in an adaptive way.
 * This means that this actor will only determine the first triple pattern,
 * execute it, and materialize the remaining BGP based on its results.
 * After that, the remaining BGP is evaluated recursively by this or another BGP actor.
 */
export class ActorQueryOperationBgpTraversal extends ActorQueryOperationTypedMediated<Algebra.Bgp> {

  constructor(args: IActorQueryOperationTypedMediatedArgs) {
    super(args, 'bgp');
  }

  public static getPatternNonVocabUris(pattern: RDF.BaseQuad): RDF.NamedNode[] {
    let nonVocabTerms: RDF.Term[];
    if (pattern.predicate.termType === 'NamedNode'
      && pattern.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
      nonVocabTerms = [ pattern.subject, pattern.graph ];
    } else {
      nonVocabTerms = [ pattern.subject, pattern.object, pattern.graph ];
    }
    return getNamedNodes(nonVocabTerms);
  }

  public static getSourceUri(namedNode: RDF.NamedNode): string {
    const value = namedNode.value;
    const hashPos = value.indexOf('#');
    return hashPos > 0 ? value.substr(0, hashPos) : value;
  }

  public static getScoreSeedNonVocab(pattern: RDF.BaseQuad, sources: string[]): number {
    return ActorQueryOperationBgpTraversal.getPatternNonVocabUris(pattern)
      .map(ActorQueryOperationBgpTraversal.getSourceUri)
      .filter((uri) => sources.indexOf(uri) >= 0)
      .length;
  }

  public static getScoreSelectivity(pattern: RDF.BaseQuad): number {
    return QUAD_TERM_NAMES.length - getVariables(getTerms(pattern)).length;
  }

  public static getPatternVariables(patterns: RDF.BaseQuad[]): string[] {
    const hash: {[variable: string]: boolean} = {};
    for (const pattern of patterns) {
      for (const variable of getVariables(getTerms(pattern))) {
        hash[termToString(variable)] = true;
      }
    }
    return Object.keys(hash);
  }

  /**
   * Create a new bindings stream
   * that takes every binding of the base stream,
   * materializes the remaining patterns with it,
   * and emits all bindings from this new set of patterns.
   *
   * This happens in a bread-first manner, so that all partial bindings are processed further in parallel.
   *
   * @param {BindingsStream} baseStream The base stream.
   * @param {Algebra.Pattern[]} patterns The patterns to materialize with each binding of the base stream.
   * @param {{ pattern: Algebra.Pattern, bindings: IPatternBindings }[]) => Promise<IActorQueryOperationOutput>}
   *    patternBinder A callback
   * to retrieve the bindings stream of an array of patterns.
   * @return {BindingsStream}
   */
  public static createBreadthFirstStream(baseStream: BindingsStream, patterns: Algebra.Pattern[],
                                         patternBinder:
                                           (patterns: { pattern: Algebra.Pattern, bindings: IPatternBindings }[]) =>
                                             Promise<BindingsStream>): BindingsStream {
    return new RoundRobinUnionIterator(baseStream.map((bindings: Bindings) => {
      const bindingsMerger = (subBindings: Bindings) => subBindings.merge(bindings);
      return new PromiseProxyIterator(
        async () => (await patternBinder(ActorQueryOperationBgpLeftDeepSmallest.materializePatterns(patterns,
          bindings))).map(bindingsMerger), { autoStart: true, maxBufferSize: 128 });
    }));
  }

  public async testOperation(pattern: Algebra.Bgp, context: ActionContext): Promise<IActorTest> {
    if (pattern.patterns.length < 2) {
      throw new Error('Actor ' + this.name + ' can only operate on BGPs with at least two patterns.');
    }
    return true;
  }

  public async runOperation(pattern: Algebra.Bgp, context: ActionContext): Promise<IActorQueryOperationOutputBindings> {
    // Determine all current sources
    const sources: string[] = [];
    if (context.has(KEY_CONTEXT_SOURCES)) {
      const dataSources: DataSources = context.get(KEY_CONTEXT_SOURCES);
      let source: IDataSource;
      const it = dataSources.iterator();
      while (source = it.read()) { // tslint:disable-line:no-conditional-assignment
        const sourceValue = getDataSourceValue(source);
        if (typeof sourceValue === 'string') {
          sources.push(sourceValue);
        }
      }
    }

    // Make a copy of the patterns to avoid modifying the original BGP
    const patterns: Algebra.Pattern[] = pattern.patterns.slice();

    // Sort the patterns by the following priorities:
    // 1. A source in S or O (not O if rdf:type) (seed rule, no vocab rule)
    // 2. Most selective: fewest variables (filtering rule, dependency-respecting rule)
    patterns.sort((patternA: Algebra.Pattern, patternB: Algebra.Pattern) => {
      const compSeedNonVocab = ActorQueryOperationBgpTraversal.getScoreSeedNonVocab(patternB, sources)
        - ActorQueryOperationBgpTraversal.getScoreSeedNonVocab(patternA, sources);
      if (compSeedNonVocab === 0) {
        return ActorQueryOperationBgpTraversal.getScoreSelectivity(patternB)
          - ActorQueryOperationBgpTraversal.getScoreSelectivity(patternA);
      }
      return compSeedNonVocab;
    });

    // Determine the first pattern
    const bestPattern: Algebra.Pattern = patterns[0];
    const remainingPatterns: Algebra.Pattern[] = patterns.slice(1);

    this.logDebug(context, 'Best traversal pattern: ', { pattern: bestPattern });

    // Evaluate the first pattern
    const subOutput: IActorQueryOperationOutputBindings = ActorQueryOperation
      .getSafeBindings(await this.mediatorQueryOperation.mediate({ operation: bestPattern, context }));

    // Materialize the remaining patterns for each binding in the stream.
    const bindingsStream: BindingsStream = ActorQueryOperationBgpTraversal.createBreadthFirstStream(
      subOutput.bindingsStream, remainingPatterns,
      async (subPatterns: { pattern: Algebra.Pattern, bindings: IPatternBindings }[]) => {
        // Send the materialized patterns to the mediator for recursive BGP evaluation.
        const operation: Algebra.Bgp = { type: 'bgp', patterns: subPatterns.map((p) => p.pattern) };

        return ActorQueryOperation.getSafeBindings(await this.mediatorQueryOperation
          .mediate({ operation, context })).bindingsStream;
      });

    // Prepare variables and metadata
    const variables: string[] = ActorQueryOperationBgpTraversal.getPatternVariables(remainingPatterns);

    return { type: 'bindings', bindingsStream, variables };
  }

}
