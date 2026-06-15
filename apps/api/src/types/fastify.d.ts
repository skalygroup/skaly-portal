declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      staffId: string;
      supabaseUid: string;
      role: 'admin' | 'manager' | 'team_member' | 'freelancer';
      email: string;
      mfaEnrolled: boolean;
    };
  }
  interface FastifyInstance {
    verifyJwt: any; // populated by auth.plugin.ts in Sprint 1
    verifyInternalSecret: any; // populated by internalAuth.plugin.ts in STEP 7
  }
}
export {};
